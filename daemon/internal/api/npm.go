package api

import (
	"context"
	"net/http"
)

// NPM is de koppeling met Nginx Proxy Manager (HTTP_MODE=npm, aangesloten in internal/daemon).
type NPM interface {
	// State is GET /api/npm.
	State() any
	// Refresh haalt de NPM-instellingen nu bij het panel op en start een ronde (POST /api/npm/refresh).
	Refresh(ctx context.Context) error
	// Test logt in met de meegegeven instellingen (POST /api/npm/test); wijzigt niets.
	Test(ctx context.Context, url, email, password string) any
}

// SetNPM koppelt NPM (zonder: 501 op /api/npm*).
func (a *API) SetNPM(n NPM) { a.npm = n }

func (a *API) npmState(w http.ResponseWriter, r *http.Request) {
	if a.npm == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "npm not available")
		return
	}
	writeJSON(w, http.StatusOK, a.npm.State())
}

func (a *API) npmRefresh(w http.ResponseWriter, r *http.Request) {
	if a.npm == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "npm not available")
		return
	}
	if err := a.npm.Refresh(r.Context()); err != nil {
		writeErr(w, http.StatusBadGateway, "panel_unreachable", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) npmTest(w http.ResponseWriter, r *http.Request) {
	var b struct {
		URL      string `json:"url"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.URL == "" || b.Email == "" || b.Password == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "url, email and password are required")
		return
	}
	if a.npm == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "npm not available")
		return
	}
	writeJSON(w, http.StatusOK, a.npm.Test(r.Context(), b.URL, b.Email, b.Password))
}
