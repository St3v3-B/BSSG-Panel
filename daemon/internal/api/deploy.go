package api

import (
	"errors"
	"net/http"
	"strconv"

	"panel/daemon/internal/deploy"
	"panel/daemon/internal/server"
)

// Deploys is wat de API van het deploy-pakket nodig heeft.
type Deploys interface {
	Start(sv *server.Server, req deploy.Request) error
	Progress(uuid string) (deploy.Progress, bool)
	Cancel(uuid string, id int) error
	ForgetServer(uuid string)
}

// SetDeploys koppelt de deploy-service (zonder: 501).
func (a *API) SetDeploys(d Deploys) { a.deploys = d }

func (a *API) startDeploy(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if a.deploys == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "git deploy is not enabled")
		return
	}
	var req deploy.Request
	if !decode(w, r, &req) {
		return
	}
	if st := s.State(); st == server.StateInstalling {
		writeErr(w, http.StatusConflict, "invalid_state", "installation is running")
		return
	}
	if a.backups != nil {
		if _, busy := a.backups.Progress(s.UUID()); busy {
			writeErr(w, http.StatusConflict, "invalid_state", "a backup or restore is running")
			return
		}
	}
	if s.DiskExceeded() {
		writeErr(w, http.StatusInsufficientStorage, "disk_exceeded", "disk limit reached")
		return
	}
	err := a.deploys.Start(s, req)
	var bad *deploy.BadRequest
	switch {
	case err == nil:
		w.WriteHeader(http.StatusAccepted)
	case errors.As(err, &bad):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, deploy.ErrNotWeb):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, deploy.ErrBusy):
		writeErr(w, http.StatusConflict, "deploy_running", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (a *API) deployProgress(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	if a.deploys == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "git deploy is not enabled")
		return
	}
	if p, ok := a.deploys.Progress(s.UUID()); ok {
		writeJSON(w, http.StatusOK, map[string]any{"deploy": p})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deploy": nil})
}

func (a *API) cancelDeploy(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if a.deploys == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "git deploy is not enabled")
		return
	}
	id, err := strconv.Atoi(r.PathValue("deploy_id"))
	if err != nil || id < 1 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid deploy_id")
		return
	}
	switch err := a.deploys.Cancel(s.UUID(), id); {
	case err == nil:
		w.WriteHeader(http.StatusAccepted)
	case errors.Is(err, deploy.ErrNotRunning):
		writeErr(w, http.StatusNotFound, "not_running", err.Error())
	case errors.Is(err, deploy.ErrNotCancellable):
		writeErr(w, http.StatusConflict, "not_cancellable", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (a *API) scanHostKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !deploy.ValidHost(req.Host) || req.Port < 1 || req.Port > 65535 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid host or port")
		return
	}
	keys, err := deploy.ScanHostKeys(r.Context(), req.Host, req.Port)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "host_unreachable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}
