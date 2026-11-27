package api

import (
	"context"
	"errors"
	"net/http"

	"panel/daemon/internal/upgrade"
)

// Upgrader is de panel-upgrade-service (alleen op de lokale node).
type Upgrader interface {
	Status(ctx context.Context, fetch bool) (upgrade.Status, error)
	Start(ctx context.Context, ref string) (upgrade.Start, error)
}

// SetUpgrade koppelt de upgrade-service (zonder: 404 not_local).
func (a *API) SetUpgrade(u Upgrader) { a.upgrader = u }

type upgradeStatusOut struct {
	upgrade.Status
	DaemonVersion string `json:"daemon_version"`
	DaemonCommit  string `json:"daemon_commit,omitempty"`
}

func (a *API) upgradeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, upgrade.ErrNotLocal):
		writeErr(w, http.StatusNotFound, "not_local", err.Error())
	case errors.Is(err, upgrade.ErrBadRef):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, upgrade.ErrRunning):
		writeErr(w, http.StatusConflict, "conflict", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (a *API) panelUpgradeStatus(w http.ResponseWriter, r *http.Request) {
	if a.upgrader == nil {
		a.upgradeErr(w, upgrade.ErrNotLocal)
		return
	}
	st, err := a.upgrader.Status(r.Context(), r.URL.Query().Get("fetch") != "0")
	if err != nil {
		a.upgradeErr(w, err)
		return
	}
	si := a.system(r.Context())
	writeJSON(w, http.StatusOK, upgradeStatusOut{Status: st, DaemonVersion: si.Version, DaemonCommit: si.Commit})
}

func (a *API) startPanelUpgrade(w http.ResponseWriter, r *http.Request) {
	if a.upgrader == nil {
		a.upgradeErr(w, upgrade.ErrNotLocal)
		return
	}
	var body struct {
		Ref string `json:"ref"`
	}
	if r.ContentLength != 0 && !decode(w, r, &body) {
		return
	}
	st, err := a.upgrader.Start(r.Context(), body.Ref)
	if err != nil {
		a.upgradeErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, st)
}
