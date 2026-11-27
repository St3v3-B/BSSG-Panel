package server

import (
	"context"
	"errors"
	"fmt"

	"panel/daemon/internal/engine"
)

// RoleSite is panel.role van een site-netwerk.
const RoleSite = "site"

// MariaDBContainer is de gedeelde MariaDB uit compose (infra). De daemon doet er alleen
// network connect/disconnect mee.
const MariaDBContainer = "panel-mariadb"

// SiteNetwork is het interne netwerk van een website.
func SiteNetwork(uuid string) string { return "panel-site-" + uuid }

// IsWeb geeft aan of de server een website is.
func (s *Server) IsWeb() bool { return s.Spec().Type == "web" }

func (m *Manager) ours(labels map[string]string) bool {
	return labels[LabelManaged] == "true" && labels[LabelInstance] == m.cfg.Instance && labels[LabelRole] == RoleSite
}

// ensureSiteNetwork maakt panel-site-<uuid> (gewone bridge: uitgaand internet, maar
// geïsoleerd van andere bridge-netwerken) als het ontbreekt en koppelt
// panel-mariadb eraan als die container bestaat.
func (m *Manager) ensureSiteNetwork(ctx context.Context, uuid string) error {
	if err := m.ensureServerNetwork(ctx, uuid); err != nil {
		return err
	}
	name := SiteNetwork(uuid)
	if _, err := m.eng.Inspect(ctx, m.cfg.MariaDB); err == nil {
		if err := m.eng.ConnectNetwork(ctx, name, m.cfg.MariaDB); err != nil {
			m.log.Warn("attaching MariaDB to site network failed", "network", name, "err", err)
		}
	}
	return nil
}

// EnsureGameNetwork zorgt voor panel-site-<uuid> van een game-server (zonder MariaDB) en
// koppelt de container als die draait (een oude container op "bridge" van vóór de
// netwerkisolatie). Aangeroepen bij het zetten van een http-route.
func (m *Manager) EnsureGameNetwork(ctx context.Context, uuid string) error {
	if err := m.ensureServerNetwork(ctx, uuid); err != nil {
		return err
	}
	return m.connectGameContainer(ctx, uuid)
}

// connectGameContainer koppelt de servercontainer aan zijn site-netwerk, als dat netwerk
// (van ons) bestaat en de container draait. Aangeroepen na elke (her)start.
func (m *Manager) connectGameContainer(ctx context.Context, uuid string) error {
	name := SiteNetwork(uuid)
	labels, err := m.eng.NetworkLabels(ctx, name)
	if errors.Is(err, engine.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !m.ours(labels) {
		return nil
	}
	if err := m.eng.ConnectNetwork(ctx, name, ContainerName(uuid)); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return fmt.Errorf("connecting container to %s: %w", name, err)
	}
	return nil
}

// removeSiteNetwork koppelt MariaDB los (alleen websites) en verwijdert het netwerk (alleen als het van ons is).
func (m *Manager) removeSiteNetwork(ctx context.Context, uuid string, web bool) error {
	name := SiteNetwork(uuid)
	labels, err := m.eng.NetworkLabels(ctx, name)
	if errors.Is(err, engine.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !m.ours(labels) {
		return nil
	}
	if !web {
		_ = m.eng.DisconnectNetwork(ctx, name, ContainerName(uuid))
	} else if err := m.eng.DisconnectNetwork(ctx, name, m.cfg.MariaDB); err != nil && !errors.Is(err, engine.ErrNotFound) {
		m.log.Warn("detaching MariaDB failed", "network", name, "err", err)
	}
	if err := m.eng.RemoveNetwork(ctx, name); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return fmt.Errorf("netwerk %s verwijderen: %w", name, err)
	}
	return nil
}

// ReconcileNetworks zorgt dat elke website zijn netwerk heeft en dat MariaDB eraan hangt
// (na een herstart van panel-mariadb is die koppeling weg). Draaiende gameservers met een
// site-netwerk (http-route) worden opnieuw gekoppeld, bijvoorbeeld na een herstart van de daemon.
// Daarna de proxy-netwerken en het opruimen van verweesde server-netwerken.
func (m *Manager) ReconcileNetworks(ctx context.Context) {
	defer m.removeOrphanServerNetworks(ctx)
	defer m.reconcileProxyNetworks(ctx)
	for _, s := range m.List() {
		if !s.IsWeb() {
			if st := s.State(); st == "online" || st == "starting" {
				if err := m.connectGameContainer(ctx, s.uuid); err != nil {
					m.log.Warn("site-netwerk (game)", "uuid", s.uuid, "err", err)
				}
			}
			continue
		}
		if err := m.ensureSiteNetwork(ctx, s.uuid); err != nil {
			m.log.Warn("site-netwerk", "uuid", s.uuid, "err", err)
		}
	}
}
