package api

import (
	"net/http"

	"panel/daemon/internal/server"
)

// players: GET /api/servers/{uuid}/players (node-token). Altijd 200; lege velden als er geen
// antwoord is, zodat het panel niet hoeft te onderscheiden tussen "offline" en "geen ping".
func (a *API) players(w http.ResponseWriter, r *http.Request, s *server.Server) {
	writeJSON(w, http.StatusOK, s.Players(r.Context()))
}
