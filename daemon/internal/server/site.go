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
	name := SiteNetwork(uuid)
	labels, err := m.eng.NetworkLabels(ctx, name)
	switch {
	case errors.Is(err, engine.ErrNotFound):
		if err := m.eng.CreateNetwork(ctx, name, m.labels(uuid, RoleSite), false); err != nil {
			return fmt.Errorf("netwerk %s aanmaken: %w", name, err)
		}
	case err != nil:
		return err
	case !m.ours(labels):
		return fmt.Errorf("network %s exists but does not belong to this daemon", name)
	}
	if _, err := m.eng.Inspect(ctx, m.cfg.MariaDB); err == nil {
		if err := m.eng.ConnectNetwork(ctx, name, m.cfg.MariaDB); err != nil {
			m.log.Warn("attaching MariaDB to site network failed", "network", name, "err", err)
		}
	}
	return nil
}

// removeSiteNetwork koppelt MariaDB los en verwijdert het netwerk (alleen als het van ons is).
func (m *Manager) removeSiteNetwork(ctx context.Context, uuid string) error {
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
	if err := m.eng.DisconnectNetwork(ctx, name, m.cfg.MariaDB); err != nil && !errors.Is(err, engine.ErrNotFound) {
		m.log.Warn("detaching MariaDB failed", "network", name, "err", err)
	}
	if err := m.eng.RemoveNetwork(ctx, name); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return fmt.Errorf("netwerk %s verwijderen: %w", name, err)
	}
	return nil
}

// ReconcileNetworks zorgt dat elke website zijn netwerk heeft en dat MariaDB eraan hangt
// (na een herstart van panel-mariadb is die koppeling weg).
func (m *Manager) ReconcileNetworks(ctx context.Context) {
	for _, s := range m.List() {
		if !s.IsWeb() {
			continue
		}
		if err := m.ensureSiteNetwork(ctx, s.uuid); err != nil {
			m.log.Warn("site-netwerk", "uuid", s.uuid, "err", err)
		}
	}
}
