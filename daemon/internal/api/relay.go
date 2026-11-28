package api

import (
	"context"
	"net/http"
)

// Relay is de HTTP(S)-relay van de daemon (internal/relay, aangesloten in internal/daemon).
type Relay interface {
	// State is GET /api/relay; withSSL voegt de SSL-status per hostnaam van de clients toe (traag).
	State(ctx context.Context, withSSL bool) any
	// Refresh haalt de relay-config nu bij het panel op (POST /api/relay/refresh).
	Refresh(ctx context.Context) error
	// Tunnel is GET /api/relay/tunnel (eigen handtekening, geen node-token).
	Tunnel(w http.ResponseWriter, r *http.Request)
}

// SetRelay koppelt de relay (zonder: 501 op /api/relay*).
func (a *API) SetRelay(r Relay) { a.relay = r }

func (a *API) relayState(w http.ResponseWriter, r *http.Request) {
	if a.relay == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "relay not available")
		return
	}
	writeJSON(w, http.StatusOK, a.relay.State(r.Context(), r.URL.Query().Get("ssl") == "1"))
}

func (a *API) relayRefresh(w http.ResponseWriter, r *http.Request) {
	if a.relay == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "relay not available")
		return
	}
	if err := a.relay.Refresh(r.Context()); err != nil {
		writeErr(w, http.StatusBadGateway, "panel_unreachable", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) relayTunnel(w http.ResponseWriter, r *http.Request) {
	if a.relay == nil {
		writeErr(w, http.StatusNotFound, "not_found", "relay not available")
		return
	}
	a.relay.Tunnel(w, r)
}
