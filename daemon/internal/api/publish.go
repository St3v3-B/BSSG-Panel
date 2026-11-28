package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"

	"panel/daemon/internal/files"
	"panel/daemon/internal/publish"
	"panel/daemon/internal/server"
)

// Staging → productie ("publiceren"), zie internal/publish. Het panel stuurt: data/copy (werkmap vullen,
// productie mag draaien) → swap (productie gestopt) → finish of rollback.

// publishLocks: één publicatiestap tegelijk per server.
var publishLocks sync.Map // uuid -> *sync.Mutex

func lockPublish(w http.ResponseWriter, s *server.Server) (unlock func(), ok bool) {
	m, _ := publishLocks.LoadOrStore(s.UUID(), &sync.Mutex{})
	mu := m.(*sync.Mutex)
	if !mu.TryLock() {
		writeErr(w, http.StatusConflict, "publish_busy", "another publish step is running for this server")
		return nil, false
	}
	return mu.Unlock, true
}

func publishID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("publish_id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "publish_id must be a positive integer")
		return 0, false
	}
	return id, true
}

func publishErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, publish.ErrNotPrepared):
		writeErr(w, http.StatusNotFound, "not_prepared", err.Error())
	case errors.Is(err, publish.ErrBadPattern):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		fileErr(w, err)
	}
}

// publishData: PUT /api/servers/{uuid}/publish/{publish_id}/data — tar-stroom (exportServerData van staging)
// in een lege werkmap van deze server.
func (a *API) publishData(w http.ResponseWriter, r *http.Request, s *server.Server) {
	id, ok := publishID(w, r)
	if !ok {
		return
	}
	unlock, ok := lockPublish(w, s)
	if !ok {
		return
	}
	defer unlock()
	if s.State() == server.StateInstalling {
		writeErr(w, http.StatusConflict, "invalid_state", "server is installing")
		return
	}
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	root := s.Root()
	dir, err := publish.Prepare(root, id)
	if err == nil {
		err = root.ImportTarInto(dir, r.Body, s.Budget())
	}
	s.RemeasureDisk()
	if err != nil {
		_ = publish.Rollback(root, id)
		publishErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// publishCopy: POST /api/servers/{uuid}/publish/{publish_id}/copy {source_uuid} — zelfde node: de datamap
// van staging rechtstreeks in de werkmap (de bron mag draaien, niet installeren).
func (a *API) publishCopy(w http.ResponseWriter, r *http.Request, s *server.Server) {
	id, ok := publishID(w, r)
	if !ok {
		return
	}
	var req copyRequest
	if !decode(w, r, &req) {
		return
	}
	if !uuidRe.MatchString(req.SourceUUID) || req.SourceUUID == s.UUID() {
		writeErr(w, http.StatusBadRequest, "bad_request", "source_uuid must be another server")
		return
	}
	src, ok := a.mgr.Get(req.SourceUUID)
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "source server unknown on this node")
		return
	}
	if src.State() == server.StateInstalling || s.State() == server.StateInstalling {
		writeErr(w, http.StatusConflict, "invalid_state", "server is installing")
		return
	}
	unlock, ok := lockPublish(w, s)
	if !ok {
		return
	}
	defer unlock()
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	root := s.Root()
	dir, err := publish.Prepare(root, id)
	if err == nil {
		err = copyInto(r.Context(), src.Root(), root, dir, s.Budget())
	}
	s.RemeasureDisk()
	if err != nil {
		_ = publish.Rollback(root, id)
		if r.Context().Err() != nil {
			return
		}
		publishErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// copyInto: ExportTarSkip van de bron (zonder `.panel-*`) rechtstreeks in ImportTarInto van het doel.
func copyInto(ctx context.Context, src, dst *files.Root, dir string, budget files.Budget) error {
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
	go func() { pw.CloseWithError(src.ExportTarSkip(pw, publish.Internal)) }()
	err := dst.ImportTarInto(dir, pr, budget)
	pr.CloseWithError(io.ErrClosedPipe)
	if err == nil {
		err = ctx.Err()
	}
	return err
}

type swapRequest struct {
	Exclude []string `json:"exclude"`
}

// publishSwap: POST /api/servers/{uuid}/publish/{publish_id}/swap {exclude} — de server moet gestopt zijn.
func (a *API) publishSwap(w http.ResponseWriter, r *http.Request, s *server.Server) {
	id, ok := publishID(w, r)
	if !ok {
		return
	}
	var req swapRequest
	if !decode(w, r, &req) {
		return
	}
	ex, err := publish.Compile(req.Exclude)
	if err != nil {
		publishErr(w, err)
		return
	}
	if !transferState(s) {
		writeErr(w, http.StatusConflict, "invalid_state", "server must be stopped (state "+s.State()+")")
		return
	}
	unlock, ok := lockPublish(w, s)
	if !ok {
		return
	}
	defer unlock()
	var kept []string
	err = publish.Swap(s.Root(), id, ex, func(m string) {
		kept = append(kept, m)
		a.log.Info("publish", "uuid", s.UUID(), "id", id, "msg", m)
	})
	s.RemeasureDisk()
	if err != nil {
		publishErr(w, err)
		return
	}
	if kept == nil {
		kept = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"log": kept})
}

// publishRollback: POST /api/servers/{uuid}/publish/{publish_id}/rollback — alles terug, werkmap weg.
func (a *API) publishRollback(w http.ResponseWriter, r *http.Request, s *server.Server) {
	id, ok := publishID(w, r)
	if !ok {
		return
	}
	unlock, ok := lockPublish(w, s)
	if !ok {
		return
	}
	defer unlock()
	if swapped, _ := publish.Swapped(s.Root(), id); swapped && !transferState(s) {
		writeErr(w, http.StatusConflict, "invalid_state", "server must be stopped (state "+s.State()+")")
		return
	}
	err := publish.Rollback(s.Root(), id)
	s.RemeasureDisk()
	if err != nil {
		publishErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// publishFinish: DELETE /api/servers/{uuid}/publish/{publish_id} — oude versie en werkmap weg.
func (a *API) publishFinish(w http.ResponseWriter, r *http.Request, s *server.Server) {
	id, ok := publishID(w, r)
	if !ok {
		return
	}
	unlock, ok := lockPublish(w, s)
	if !ok {
		return
	}
	defer unlock()
	err := publish.Finish(s.Root(), id)
	s.RemeasureDisk()
	if err != nil {
		publishErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
