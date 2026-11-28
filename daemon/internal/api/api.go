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
	"sync/atomic"
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
	Commit           string `json:"commit,omitempty"`
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
	// Update haalt en installeert de huidige daemon-binary (POST /api/update); changed=false: al bijgewerkt.
	Update func(context.Context) (changed bool, err error)
	// Restart herstart het proces na een geslaagde update (systemd start de nieuwe binary).
	Restart func()
	// TerminalIdle / TerminalMax: webterminal sluiten na zoveel tijd zonder invoer / na zoveel tijd open
	// (standaard 15 min en 4 uur).
	TerminalIdle, TerminalMax time.Duration
}

// API bundelt de handlers.
type API struct {
	opt      Options
	mgr      *server.Manager
	routes   *Routes
	jwt      JWTVerifier
	backups  Backups
	deploys  Deploys
	dbadmin  DBAdmin
	dbHost   string
	upgrader Upgrader
	relay    Relay
	npm      NPM
	system   func(ctx context.Context) SystemInfo
	log      *slog.Logger

	jti jtiStore
	// tunnels: open databasetunnels (GET /api/db/tunnel).
	tunnels atomic.Int32

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
	mux.Handle("POST /api/update", p(a.updateDaemon))
	mux.Handle("GET /api/panel-upgrade/status", p(a.panelUpgradeStatus))
	mux.Handle("POST /api/panel-upgrade", p(a.startPanelUpgrade))
	mux.Handle("GET /api/servers", p(a.listServers))
	mux.Handle("POST /api/servers", p(a.createServer))
	mux.Handle("GET /api/servers/{uuid}", p(a.withServer(a.getServer)))
	mux.Handle("PUT /api/servers/{uuid}", p(a.withServer(a.updateServer)))
	mux.Handle("DELETE /api/servers/{uuid}", p(a.withServer(a.deleteServer)))
	mux.Handle("POST /api/servers/{uuid}/install", p(a.withServer(a.reinstall)))
	mux.Handle("POST /api/servers/{uuid}/image-update", p(a.withServer(a.updateImage)))
	mux.Handle("POST /api/images/check", p(a.checkImages))
	mux.Handle("POST /api/servers/{uuid}/power", p(a.withServer(a.power)))
	mux.Handle("POST /api/servers/{uuid}/commands", p(a.withServer(a.commands)))
	mux.Handle("POST /api/servers/{uuid}/exec", p(a.withServer(a.exec)))
	mux.Handle("GET /api/servers/{uuid}/logs", p(a.withServer(a.logs)))
	mux.Handle("GET /api/servers/{uuid}/stats", p(a.withServer(a.stats)))
	mux.Handle("GET /api/servers/{uuid}/players", p(a.withServer(a.players)))
	mux.Handle("GET /api/servers/{uuid}/network", p(a.withServer(a.getProxyNetwork)))
	mux.Handle("PUT /api/servers/{uuid}/network", p(a.withServer(a.setProxyNetwork)))
	mux.Handle("GET /api/stats", p(a.allStats))
	mux.HandleFunc("GET /api/servers/{uuid}/ws", a.websocket)
	mux.HandleFunc("GET /api/servers/{uuid}/terminal", a.terminal)

	mux.Handle("GET /api/servers/{uuid}/files/list", p(a.withServer(a.listFiles)))
	mux.Handle("GET /api/servers/{uuid}/files/contents", p(a.withServer(a.readFile)))
	mux.Handle("PUT /api/servers/{uuid}/files/contents", p(a.withServer(a.writeFile)))
	mux.Handle("POST /api/servers/{uuid}/files/mkdir", p(a.withServer(a.mkdir)))
	mux.Handle("POST /api/servers/{uuid}/files/rename", p(a.withServer(a.rename)))
	mux.Handle("POST /api/servers/{uuid}/files/delete", p(a.withServer(a.deleteFiles)))
	mux.Handle("POST /api/servers/{uuid}/files/compress", p(a.withServer(a.compress)))
	mux.Handle("POST /api/servers/{uuid}/files/decompress", p(a.withServer(a.decompress)))
	mux.Handle("POST /api/servers/{uuid}/files/search", p(a.withServer(a.searchFiles)))
	mux.Handle("POST /api/servers/{uuid}/files/chmod", p(a.withServer(a.chmodFiles)))
	mux.Handle("GET /api/servers/{uuid}/transfer/export", p(a.withServer(a.exportData)))
	mux.Handle("PUT /api/servers/{uuid}/transfer/import", p(a.withServer(a.importData)))
	mux.Handle("POST /api/servers/{uuid}/transfer/copy", p(a.withServer(a.copyData)))
	mux.HandleFunc("POST /api/servers/{uuid}/files/upload", a.cors(a.upload))
	mux.HandleFunc("GET /api/servers/{uuid}/files/download", a.cors(a.download))
	mux.HandleFunc("OPTIONS /api/servers/{uuid}/files/upload", a.cors(preflight))
	mux.HandleFunc("OPTIONS /api/servers/{uuid}/files/download", a.cors(preflight))
	mux.HandleFunc("GET /api/servers/{uuid}/files/archive", a.cors(a.downloadArchive))
	mux.HandleFunc("OPTIONS /api/servers/{uuid}/files/archive", a.cors(preflight))

	mux.Handle("POST /api/servers/{uuid}/backups", p(a.withServer(a.createBackup)))
	mux.Handle("POST /api/servers/{uuid}/backups/{backup_id}/restore", p(a.withServer(a.restoreBackup)))
	mux.Handle("GET /api/servers/{uuid}/backups/progress", p(a.withServer(a.backupProgress)))
	mux.Handle("POST /api/servers/{uuid}/backups/{backup_id}/cancel", p(a.withServer(a.cancelBackup)))

	mux.Handle("POST /api/servers/{uuid}/deploy", p(a.withServer(a.startDeploy)))
	mux.Handle("GET /api/servers/{uuid}/deploy", p(a.withServer(a.deployProgress)))
	mux.Handle("POST /api/servers/{uuid}/deploy/{deploy_id}/cancel", p(a.withServer(a.cancelDeploy)))
	mux.Handle("POST /api/git/host-key", p(a.scanHostKey))

	mux.Handle("GET /api/db/status", p(a.dbStatus))
	mux.Handle("POST /api/db/databases", p(a.dbCreate))
	mux.Handle("DELETE /api/db/databases/{name}", p(a.dbDrop))
	mux.Handle("PUT /api/db/databases/{name}/password", p(a.dbPassword))
	mux.Handle("PUT /api/db/pma-users/{username}", p(a.dbPmaUser))
	mux.Handle("GET /api/db/tunnel", p(a.dbTunnel))
	mux.Handle("GET /api/db/databases/{name}/dump", p(a.dbDump))
	mux.Handle("PUT /api/db/databases/{name}/import", p(a.dbImport))

	mux.Handle("GET /api/relay", p(a.relayState))
	mux.Handle("POST /api/relay/refresh", p(a.relayRefresh))
	mux.HandleFunc("GET /api/relay/tunnel", a.relayTunnel)
	mux.Handle("GET /api/npm", p(a.npmState))
	mux.Handle("POST /api/npm/refresh", p(a.npmRefresh))
	mux.Handle("POST /api/npm/test", p(a.npmTest))
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
	if a.deploys != nil {
		if p, ok := a.deploys.Progress(s.UUID()); ok {
			_ = a.deploys.Cancel(s.UUID(), p.DeployID)
		}
	}
	if err := a.mgr.Delete(s.UUID()); err != nil {
		stateErr(w, err)
		return
	}
	if a.deploys != nil {
		a.deploys.ForgetServer(s.UUID())
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

func (a *API) exec(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Command        string `json:"command"`
		TimeoutSeconds int    `json:"timeout_seconds"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !s.IsWeb() {
		writeErr(w, http.StatusBadRequest, "bad_request", "exec is only available for websites")
		return
	}
	if strings.TrimSpace(body.Command) == "" || len(body.Command) > 2000 || strings.ContainsRune(body.Command, 0) {
		writeErr(w, http.StatusBadRequest, "bad_request", "command is empty, too long or invalid")
		return
	}
	if body.TimeoutSeconds == 0 {
		body.TimeoutSeconds = 60
	}
	if body.TimeoutSeconds < 1 || body.TimeoutSeconds > 600 {
		writeErr(w, http.StatusBadRequest, "bad_request", "timeout_seconds must be between 1 and 600")
		return
	}
	res, err := s.Exec(r.Context(), body.Command, time.Duration(body.TimeoutSeconds)*time.Second)
	if err != nil {
		stateErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"exit_code": res.ExitCode, "output": strings.ToValidUTF8(res.Output, "\uFFFD"), "truncated": res.Truncated,
		"timed_out": res.TimedOut, "duration_ms": res.Duration.Milliseconds(),
	})
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

type serverStats struct {
	UUID string `json:"uuid"`
	server.Stats
}

// allStats: de laatste meting van alle draaiende servers (voor de verbruiksgrafieken van het panel).
func (a *API) allStats(w http.ResponseWriter, _ *http.Request) {
	out := []serverStats{}
	for _, s := range a.mgr.List() {
		if st, ok := s.RunningStats(); ok {
			out = append(out, serverStats{UUID: s.UUID(), Stats: st})
		}
	}
	writeJSON(w, http.StatusOK, map[string][]serverStats{"servers": out})
}

// updateDaemon: alleen met het node-token (protect); een browser-JWT volstaat niet.
func (a *API) updateDaemon(w http.ResponseWriter, r *http.Request) {
	if a.opt.Update == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "updates are not enabled")
		return
	}
	changed, err := a.opt.Update(r.Context())
	if err != nil {
		a.log.Warn("daemon update failed", "err", err)
		writeErr(w, http.StatusBadGateway, "update_failed", err.Error())
		return
	}
	if !changed {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "restarting"})
	if a.opt.Restart != nil {
		go func() {
			time.Sleep(500 * time.Millisecond) // antwoord eerst afleveren
			a.opt.Restart()
		}()
	}
}
