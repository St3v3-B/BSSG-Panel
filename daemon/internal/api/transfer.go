package api

import (
	"net/http"

	"panel/daemon/internal/server"
)

// transferState: alleen een gestopte server mag verplaatst worden.
func transferState(s *server.Server) bool {
	switch s.State() {
	case server.StateOffline, server.StateSleeping, server.StateInstallFailed:
		return true
	}
	return false
}

// exportData streamt de hele datamap als tar (GET /api/servers/{uuid}/transfer/export).
func (a *API) exportData(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	if !transferState(s) {
		writeErr(w, http.StatusConflict, "invalid_state", "server must be stopped (state "+s.State()+")")
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.WriteHeader(http.StatusOK)
	if err := s.Root().ExportTar(w); err != nil {
		// De status staat al verstuurd: de verbinding afbreken zodat de ontvanger een fout ziet
		// in plaats van een afgekapte maar geldige tar.
		a.log.Warn("transfer export", "uuid", s.UUID(), "err", err)
		panic(http.ErrAbortHandler)
	}
}

// importData pakt een tar-stroom uit in de datamap (PUT /api/servers/{uuid}/transfer/import).
func (a *API) importData(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if !transferState(s) {
		writeErr(w, http.StatusConflict, "invalid_state", "server must be stopped (state "+s.State()+")")
		return
	}
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	err := s.Root().ImportTar(r.Body, s.Budget())
	s.RemeasureDisk()
	if err != nil {
		fileErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
