// Package api is de HTTP-API van de daemon (packages/api/openapi.yaml).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"panel/daemon/internal/auth"
	"panel/daemon/internal/server"
	"panel/daemon/internal/spec"
)

// SystemInfo is het SystemInfo-schema.
type SystemInfo struct {
	Version          string `json:"version"`
	DiskQuotaMode    string `json:"disk_quota_mode"`
	CPUCount         int    `json:"cpu_count"`
	MemoryTotalBytes int64  `json:"memory_total_bytes"`
	MemoryUsedBytes  int64  `json:"memory_used_bytes"`
	DiskTotalBytes   int64  `json:"disk_total_bytes"`
	DiskFreeBytes    int64  `json:"disk_free_bytes"`
	DockerVersion    string `json:"docker_version"`
	ServerCount      int    `json:"server_count"`
	CaddyHealthy     *bool  `json:"caddy_healthy,omitempty"`
}

// JWTVerifier controleert browser-JWT's.
type JWTVerifier interface {
	Verify(ctx context.Context, token string) (*auth.Claims, error)
}

// Options voor de API.
type Options struct {
	NodeToken      string
	AllowedOrigins []string // naast "geen Origin"
	AuthTimeout    time.Duration
	PingInterval   time.Duration
}

// API bundelt de handlers.
type API struct {
	opt    Options
	mgr    *server.Manager
	routes *Routes
	jwt    JWTVerifier
	system func(ctx context.Context) SystemInfo
	log    *slog.Logger

	jti jtiStore

	wsMu   sync.Mutex
	wsConn map[*session]struct{}
}

// New maakt de API.
func New(opt Options, mgr *server.Manager, routes *Routes, jwt JWTVerifier, system func(context.Context) SystemInfo, log *slog.Logger) *API {
	if opt.AuthTimeout == 0 {
		opt.AuthTimeout = 10 * time.Second
	}
	if opt.PingInterval == 0 {
		opt.PingInterval = 30 * time.Second
	}
	return &API{opt: opt, mgr: mgr, routes: routes, jwt: jwt, system: system, log: log, wsConn: map[*session]struct{}{}}
}

// Error is het Error-schema.
type Error struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, Error{Error: errCode, Message: msg})
}

// Handler geeft de http.Handler met alle routes.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	p := a.protect

	mux.Handle("GET /api/system", p(a.getSystem))
	mux.Handle("GET /api/servers", p(a.listServers))
	mux.Handle("POST /api/servers", p(a.createServer))
	mux.Handle("GET /api/servers/{uuid}", p(a.withServer(a.getServer)))
	mux.Handle("PUT /api/servers/{uuid}", p(a.withServer(a.updateServer)))
	mux.Handle("DELETE /api/servers/{uuid}", p(a.withServer(a.deleteServer)))
	mux.Handle("POST /api/servers/{uuid}/install", p(a.withServer(a.reinstall)))
	mux.Handle("POST /api/servers/{uuid}/power", p(a.withServer(a.power)))
	mux.Handle("POST /api/servers/{uuid}/commands", p(a.withServer(a.commands)))
	mux.Handle("GET /api/servers/{uuid}/logs", p(a.withServer(a.logs)))
	mux.Handle("GET /api/servers/{uuid}/stats", p(a.withServer(a.stats)))
	mux.HandleFunc("GET /api/servers/{uuid}/ws", a.websocket)

	mux.Handle("GET /api/servers/{uuid}/files/list", p(a.withServer(a.listFiles)))
	mux.Handle("GET /api/servers/{uuid}/files/contents", p(a.withServer(a.readFile)))
	mux.Handle("PUT /api/servers/{uuid}/files/contents", p(a.withServer(a.writeFile)))
	mux.Handle("POST /api/servers/{uuid}/files/mkdir", p(a.withServer(a.mkdir)))
	mux.Handle("POST /api/servers/{uuid}/files/rename", p(a.withServer(a.rename)))
	mux.Handle("POST /api/servers/{uuid}/files/delete", p(a.withServer(a.deleteFiles)))
	mux.Handle("POST /api/servers/{uuid}/files/compress", p(a.withServer(a.compress)))
	mux.Handle("POST /api/servers/{uuid}/files/decompress", p(a.withServer(a.decompress)))
	mux.HandleFunc("POST /api/servers/{uuid}/files/upload", a.cors(a.upload))
	mux.HandleFunc("GET /api/servers/{uuid}/files/download", a.cors(a.download))
	mux.HandleFunc("OPTIONS /api/servers/{uuid}/files/upload", a.cors(preflight))
	mux.HandleFunc("OPTIONS /api/servers/{uuid}/files/download", a.cors(preflight))

	// Fase 4: not implemented yet.
	ni := func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "not implemented yet")
	}
	mux.Handle("POST /api/servers/{uuid}/backups", p(ni))
	mux.Handle("POST /api/servers/{uuid}/backups/{backup_id}/restore", p(ni))

	mux.Handle("GET /api/routes", p(a.listRoutes))
	mux.Handle("GET /api/routes/{host}", p(a.getRoute))
	mux.Handle("PUT /api/routes/{host}", p(a.setRoute))
	mux.Handle("DELETE /api/routes/{host}", p(a.removeRoute))

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "unknown path")
	})
	return recoverer(a.log, mux)
}

func recoverer(log *slog.Logger, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				log.Error("panic in handler", "path", r.URL.Path, "panic", v)
				writeErr(w, http.StatusInternalServerError, "internal", "internal error")
			}
		}()
		h.ServeHTTP(w, r)
	})
}

// protect eist het node-token.
func (a *API) protect(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr := r.Header.Get("Authorization")
		tok, ok := strings.CutPrefix(hdr, "Bearer ")
		if !ok || !auth.TokenEqual(strings.TrimSpace(tok), a.opt.NodeToken) {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "node token missing or invalid")
			return
		}
		h(w, r)
	})
}

type serverHandler func(w http.ResponseWriter, r *http.Request, s *server.Server)

func (a *API) withServer(h serverHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, ok := a.mgr.Get(r.PathValue("uuid"))
		if !ok {
			writeErr(w, http.StatusNotFound, "not_found", "server unknown on this node")
			return
		}
		h(w, r, s)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 4<<20))
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON: "+err.Error())
		return false
	}
	return true
}

func stateErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, server.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, server.ErrInvalidState):
		writeErr(w, http.StatusConflict, "invalid_state", err.Error())
	case errors.Is(err, server.ErrNotRunning):
		writeErr(w, http.StatusConflict, "not_running", err.Error())
	case errors.Is(err, server.ErrDiskExceeded):
		writeErr(w, http.StatusConflict, "disk_exceeded", err.Error())
	case errors.Is(err, server.ErrExists):
		writeErr(w, http.StatusConflict, "conflict", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

// ---------- system ----------

func (a *API) getSystem(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.system(r.Context()))
}

// ---------- servers ----------

func (a *API) listServers(w http.ResponseWriter, _ *http.Request) {
	out := []server.View{}
	for _, s := range a.mgr.List() {
		out = append(out, s.View())
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) createServer(w http.ResponseWriter, r *http.Request) {
	var sp spec.ServerSpec
	if !decode(w, r, &sp) {
		return
	}
	if err := sp.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s, _, err := a.mgr.Create(sp)
	if err != nil {
		stateErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, s.View())
}

func (a *API) getServer(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	writeJSON(w, http.StatusOK, s.View())
}

func (a *API) updateServer(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var sp spec.ServerSpec
	if !decode(w, r, &sp) {
		return
	}
	if sp.UUID == "" {
		sp.UUID = s.UUID()
	}
	sp.UUID = strings.ToLower(sp.UUID)
	if sp.UUID != s.UUID() {
		writeErr(w, http.StatusBadRequest, "bad_request", "uuid in body differs from the path")
		return
	}
	if err := sp.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := s.Update(sp); err != nil {
		stateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.View())
}

func (a *API) deleteServer(w http.ResponseWriter, r *http.Request, s *server.Server) {
	// Eerst de routes, zodat Caddy van het site-netwerk loskomt en dat weg kan.
	if err := a.routes.RemoveServer(r.Context(), s.UUID()); err != nil {
		a.log.Warn("routes van verwijderde server", "uuid", s.UUID(), "err", err)
	}
	if err := a.mgr.Delete(s.UUID()); err != nil {
		stateErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) reinstall(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	if err := s.Reinstall(); err != nil {
		stateErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

var powerActions = map[string]bool{"start": true, "stop": true, "restart": true, "kill": true}

func (a *API) power(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Action string `json:"action"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !powerActions[body.Action] {
		writeErr(w, http.StatusBadRequest, "bad_request", "action must be start, stop, restart or kill")
		return
	}
	if err := s.Power(body.Action); err != nil {
		stateErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) commands(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Commands []string `json:"commands"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Commands) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "commands is leeg")
		return
	}
	for _, c := range body.Commands {
		if len(c) > 2000 || strings.ContainsAny(c, "\r\n") {
			writeErr(w, http.StatusBadRequest, "bad_request", "command too long or contains a line break")
			return
		}
	}
	for _, c := range body.Commands {
		if err := s.SendCommand(c); err != nil {
			stateErr(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) logs(w http.ResponseWriter, r *http.Request, s *server.Server) {
	n := 100
	if v := r.URL.Query().Get("lines"); v != "" {
		i, err := strconv.Atoi(v)
		if err != nil || i < 1 || i > 500 {
			writeErr(w, http.StatusBadRequest, "bad_request", "lines must be between 1 and 500")
			return
		}
		n = i
	}
	writeJSON(w, http.StatusOK, map[string][]string{"lines": s.Logs(n)})
}

func (a *API) stats(w http.ResponseWriter, _ *http.Request, s *server.Server) {
	writeJSON(w, http.StatusOK, s.Stats())
}
