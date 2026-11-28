package api

import (
	"context"
	"io"
	"net/http"
	"regexp"

	"panel/daemon/internal/publish"
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

// liveExport: met ?live=1 mag ook een draaiende server geëxporteerd worden (kopie maken). Het panel
// bevriest de wereld zelf (save-off) als dat nodig is; bestanden die tijdens het lezen krimpen geven een fout.
func liveExport(r *http.Request) bool {
	v := r.URL.Query().Get("live")
	return v == "1" || v == "true"
}

// exportData streamt de hele datamap als tar (GET /api/servers/{uuid}/transfer/export).
func (a *API) exportData(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if !transferState(s) && !(liveExport(r) && s.State() != server.StateInstalling) {
		writeErr(w, http.StatusConflict, "invalid_state", "server must be stopped (state "+s.State()+")")
		return
	}
	w.Header().Set("Content-Type", "application/x-tar")
	w.WriteHeader(http.StatusOK)
	// ?exclude_internal=1 (publiceren): namen `.panel-*` (git-deploy, werkmappen) niet meesturen.
	var skip func(string) bool
	if v := r.URL.Query().Get("exclude_internal"); v == "1" || v == "true" {
		skip = publish.Internal
	}
	if err := s.Root().ExportTarSkip(w, skip); err != nil {
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

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type copyRequest struct {
	SourceUUID string `json:"source_uuid"`
	Live       bool   `json:"live"`
}

// copyData kopieert de datamap van een andere server op deze node naar deze (gestopte) server
// (POST /api/servers/{uuid}/transfer/copy), zonder dat de data het panel passeert. Zelfde regels als
// export + import; afbreken van het verzoek stopt de kopie (de gedeeltelijke inhoud blijft staan).
func (a *API) copyData(w http.ResponseWriter, r *http.Request, dst *server.Server) {
	var req copyRequest
	if !decode(w, r, &req) {
		return
	}
	if !uuidRe.MatchString(req.SourceUUID) || req.SourceUUID == dst.UUID() {
		writeErr(w, http.StatusBadRequest, "bad_request", "source_uuid must be another server")
		return
	}
	src, ok := a.mgr.Get(req.SourceUUID)
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "source server unknown on this node")
		return
	}
	if !transferState(dst) {
		writeErr(w, http.StatusConflict, "invalid_state", "target must be stopped (state "+dst.State()+")")
		return
	}
	if !transferState(src) && !(req.Live && src.State() != server.StateInstalling) {
		writeErr(w, http.StatusConflict, "invalid_state", "source must be stopped (state "+src.State()+")")
		return
	}
	if err := dst.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	err := copyTree(r.Context(), src, dst)
	dst.RemeasureDisk()
	if err != nil {
		if r.Context().Err() != nil {
			a.log.Info("transfer copy canceled", "from", src.UUID(), "to", dst.UUID())
			return
		}
		fileErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// copyTree: ExportTar van de bron rechtstreeks in ImportTar van het doel (via een pipe).
func copyTree(ctx context.Context, src, dst *server.Server) error {
	pr, pw := io.Pipe()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			pr.CloseWithError(ctx.Err())
		case <-done:
		}
	}()
	go func() { pw.CloseWithError(src.Root().ExportTar(pw)) }()
	err := dst.Root().ImportTar(pr, dst.Budget())
	// Lees de rest weg zodat de exporter niet blijft hangen (bijv. na een fout van de import).
	pr.CloseWithError(io.ErrClosedPipe)
	if err == nil {
		err = ctx.Err()
	}
	return err
}
