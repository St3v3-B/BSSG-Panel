package api

import (
	"errors"
	"net/http"

	"panel/daemon/internal/server"
)

// ProxyNetwork is de body en het antwoord van PUT/GET /api/servers/{uuid}/network.
type ProxyNetwork struct {
	Members []string `json:"members"`
	// Network: naam van het gedeelde Docker-netwerk (leeg als er geen leden zijn).
	Network string `json:"network"`
}

func proxyNetworkOf(mgr *server.Manager, uuid string) ProxyNetwork {
	m := mgr.ProxyMembers(uuid)
	if m == nil {
		m = []string{}
	}
	out := ProxyNetwork{Members: m}
	if len(m) > 0 {
		out.Network = server.ProxyNetwork(uuid)
	}
	return out
}

func (a *API) getProxyNetwork(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	writeJSON(w, http.StatusOK, proxyNetworkOf(a.mgr, s.UUID()))
}

func (a *API) setProxyNetwork(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body ProxyNetwork
	if !decode(w, r, &body) {
		return
	}
	if len(body.Members) > 60 {
		writeErr(w, http.StatusBadRequest, "bad_request", "at most 60 members")
		return
	}
	if err := a.mgr.SetProxyNetwork(r.Context(), s.UUID(), body.Members); err != nil {
		if errors.Is(err, server.ErrBadMember) {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		stateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, proxyNetworkOf(a.mgr, s.UUID()))
}
