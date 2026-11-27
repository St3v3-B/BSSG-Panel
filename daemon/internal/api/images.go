package api

import (
	"context"
	"net/http"

	"panel/daemon/internal/server"
)

func (a *API) updateImage(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	if err := a.mgr.UpdateImageNow(s.UUID()); err != nil {
		stateErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) checkImages(w http.ResponseWriter, _ *http.Request) {
	go a.mgr.CheckImages(context.Background())
	w.WriteHeader(http.StatusAccepted)
}
