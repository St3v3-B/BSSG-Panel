package server

import (
	"context"
	"fmt"

	"panel/daemon/internal/engine"
)

// Hulpfuncties voor het backup-pakket: dat bouwt op de manager maar hoort niet in de
// levenscyclus-code.

// Engine geeft de Docker-laag.
func (m *Manager) Engine() engine.Engine { return m.eng }

// Volume is de datamap van een server.
func (m *Manager) Volume(uuid string) string { return m.volume(uuid) }

// DataDir is de basismap van de daemon ($DATA_DIR).
func (m *Manager) DataDir() string { return m.cfg.DataDir }

// Owner is de uid/gid waaronder servers draaien.
func (m *Manager) Owner() (int, int) { return m.cfg.UID, m.cfg.GID }

// MariaDBName is de containernaam van de gedeelde MariaDB.
func (m *Manager) MariaDBName() string { return m.cfg.MariaDB }

// TempLabels geeft de labels voor een tijdelijke container van server uuid (role=install).
func (m *Manager) TempLabels(uuid string) map[string]string { return m.labels(uuid, RoleInstall) }

// DBNetwork geeft het netwerk waarop een tijdelijke container de databasehost mariaHost
// bereikt. Voor de lokale MariaDB is dat het site-netwerk van de website; anders het
// standaardnetwerk (externe hosts).
func (m *Manager) DBNetwork(ctx context.Context, s *Server, host string) (string, error) {
	if host == m.cfg.MariaDB && s.IsWeb() {
		if err := m.ensureSiteNetwork(ctx, s.uuid); err != nil {
			return "", fmt.Errorf("site network: %w", err)
		}
		return SiteNetwork(s.uuid), nil
	}
	return m.cfg.NetworkMode, nil
}

// Publish stuurt een bericht naar alle websockets van de server.
func (s *Server) Publish(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publishLocked(v)
}

// HoldStopped stopt de server (als hij draait) en houdt hem uit tot release wordt
// aangeroepen: start- en stopacties wachten zolang. Na release start de server niet
// vanzelf; dat is aan de aanroeper.
func (s *Server) HoldStopped() (release func(), err error) {
	s.mu.Lock()
	installing := s.installing || s.state == StateInstalling
	deleted := s.deleted
	s.mu.Unlock()
	if deleted {
		return nil, ErrNotFound
	}
	if installing {
		return nil, &StateError{StateInstalling, "installation is running"}
	}
	s.opMu.Lock()
	if err := s.doStop(false); err != nil {
		s.opMu.Unlock()
		return nil, err
	}
	return s.opMu.Unlock, nil
}

// WasRunning meldt of de server draait of start (voor herstarten na een herstel).
func (s *Server) WasRunning() bool {
	st := s.State()
	return st == StateOnline || st == StateStarting
}

// StartAfter start de server op de achtergrond.
func (s *Server) StartAfter() { _ = s.Power("start") }
