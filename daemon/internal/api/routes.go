package api

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"panel/daemon/internal/server"
	"panel/daemon/internal/store"
	"panel/daemon/proxy"
)

// DNSChallenge zoals in openapi.yaml.
type DNSChallenge struct {
	Provider string `json:"provider"`
	APIToken string `json:"api_token"`
}

// Route is het Route-schema.
type Route struct {
	Host         string        `json:"host"`
	ServerUUID   string        `json:"server_uuid"`
	Port         *int          `json:"port"`
	RedirectTo   *string       `json:"redirect_to"`
	Wildcard     bool          `json:"wildcard"`
	DNSChallenge *DNSChallenge `json:"dns_challenge"`
}

// RouteWithStatus is het RouteWithStatus-schema.
type RouteWithStatus struct {
	Route
	SSLStatus string     `json:"ssl_status"`
	SSLError  *string    `json:"ssl_error"`
	CheckedAt *time.Time `json:"checked_at"`
}

// Routes is de routeset van de daemon (bron van waarheid) met opslag in routes.json.
type Routes struct {
	path   string
	router proxy.Router
	mgr    *server.Manager
	log    *slog.Logger

	mu     sync.Mutex
	routes map[string]Route
	// extra: routes die niet van deze node zijn (HTTP(S)-relay voor andere nodes); bij Sync erbij.
	extra func() []proxy.Route

	refreshMu sync.Mutex
}

// placeholder geeft de standaardpagina voor de staat van een website.
func placeholder(state string) proxy.Placeholder {
	switch state {
	case server.StateInstalling, server.StateInstallFailed:
		return proxy.PlaceholderInstalling
	case server.StateOffline, server.StateStopping:
		return proxy.PlaceholderOffline
	case server.StateDiskExceeded:
		return proxy.PlaceholderDisk
	}
	return proxy.PlaceholderNone
}

// Refresh zet de routes van een website opnieuw in de Router met de placeholder van
// zijn huidige staat. Geserialiseerd, en de staat wordt pas binnen de lock gelezen, zodat
// de laatste aanroep altijd de actuele staat zet.
func (r *Routes) Refresh(ctx context.Context, uuid string) {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	if s, ok := r.mgr.Get(uuid); !ok || !s.IsWeb() {
		return
	}
	r.mu.Lock()
	var list []proxy.Route
	for _, rt := range r.routes {
		if rt.ServerUUID != uuid || (rt.RedirectTo != nil && *rt.RedirectTo != "") {
			continue
		}
		if pr, ok := r.toProxy(rt); ok {
			list = append(list, pr)
		}
	}
	r.mu.Unlock()
	for _, pr := range list {
		if err := r.router.SetRoute(ctx, pr); err != nil {
			r.log.Warn("placeholder bijwerken mislukt", "host", pr.Host, "err", err)
		}
	}
}

// NewRoutes laadt routes.json (als die bestaat).
func NewRoutes(path string, router proxy.Router, mgr *server.Manager, log *slog.Logger) (*Routes, error) {
	r := &Routes{path: path, router: router, mgr: mgr, log: log, routes: map[string]Route{}}
	var list []Route
	if err := store.ReadJSON(path, &list); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	for _, rt := range list {
		r.routes[rt.Host] = rt
	}
	return r, nil
}

func (r *Routes) saveLocked() error {
	list := make([]Route, 0, len(r.routes))
	for _, rt := range r.routes {
		list = append(list, rt)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Host < list[j].Host })
	return store.WriteJSON(r.path, list)
}

// toProxy zet een API-route om naar een proxy.Route.
func (r *Routes) toProxy(rt Route) (proxy.Route, bool) {
	pr := proxy.Route{Host: rt.Host, ServerUUID: rt.ServerUUID, Wildcard: rt.Wildcard}
	if rt.RedirectTo != nil && *rt.RedirectTo != "" {
		pr.RedirectTo = *rt.RedirectTo
	}
	if rt.DNSChallenge != nil {
		pr.DNSChallenge = &proxy.DNSChallenge{Provider: rt.DNSChallenge.Provider, APIToken: rt.DNSChallenge.APIToken}
	}
	port := 0
	if rt.Port != nil {
		port = *rt.Port
	} else if s, ok := r.mgr.Get(rt.ServerUUID); ok {
		if hp := s.Spec().HTTPPort; hp != nil {
			port = *hp
		}
	}
	if port == 0 && pr.RedirectTo == "" {
		return pr, false
	}
	pr.Upstream = proxy.Upstream{Container: server.ContainerName(rt.ServerUUID), Port: port}
	if s, ok := r.mgr.Get(rt.ServerUUID); ok {
		pr.Upstream.Network = server.SiteNetwork(rt.ServerUUID)
		// Game-routes krijgen nooit een placeholder.
		if s.IsWeb() && pr.RedirectTo == "" {
			pr.Placeholder = placeholder(s.State())
		}
	}
	return pr, true
}

// SetExtra zet de bron van routes voor andere nodes (relay). Eigen routes gaan voor bij gelijke host.
func (r *Routes) SetExtra(fn func() []proxy.Route) {
	r.mu.Lock()
	r.extra = fn
	r.mu.Unlock()
}

// All geeft de proxy-routes voor Sync.
func (r *Routes) All() []proxy.Route {
	r.mu.Lock()
	extra := r.extra
	out := make([]proxy.Route, 0, len(r.routes))
	for _, rt := range r.routes {
		if pr, ok := r.toProxy(rt); ok {
			out = append(out, pr)
		}
	}
	r.mu.Unlock()
	if extra != nil {
		own := make(map[string]bool, len(out))
		for _, pr := range out {
			own[pr.Host] = true
		}
		for _, pr := range extra() {
			if !own[pr.Host] {
				out = append(out, pr)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Host < out[j].Host })
	return out
}

// Sync zet de volledige routeset in de Router.
func (r *Routes) Sync(ctx context.Context) error {
	return r.router.Sync(ctx, r.All())
}

// RemoveServer haalt alle routes van een server weg.
func (r *Routes) RemoveServer(ctx context.Context, uuid string) error {
	r.mu.Lock()
	var hosts []string
	for h, rt := range r.routes {
		if rt.ServerUUID == uuid {
			hosts = append(hosts, h)
			delete(r.routes, h)
		}
	}
	err := r.saveLocked()
	r.mu.Unlock()
	for _, h := range hosts {
		if e := r.router.RemoveRoute(ctx, h); e != nil && !errors.Is(e, proxy.ErrNotFound) {
			err = errors.Join(err, e)
		}
	}
	return err
}

func (r *Routes) withStatus(ctx context.Context, rt Route) RouteWithStatus {
	// Het DNS-token gaat nooit terug in een API-antwoord (alleen de provider).
	if rt.DNSChallenge != nil {
		rt.DNSChallenge = &DNSChallenge{Provider: rt.DNSChallenge.Provider}
	}
	out := RouteWithStatus{Route: rt, SSLStatus: string(proxy.SSLPending)}
	st, err := r.router.Status(ctx, rt.Host)
	switch {
	case err == nil:
		out.SSLStatus = string(st.SSL)
		if st.Error != "" {
			e := st.Error
			out.SSLError = &e
		}
		if !st.CheckedAt.IsZero() {
			t := st.CheckedAt.UTC()
			out.CheckedAt = &t
		}
	case errors.Is(err, proxy.ErrNotFound):
	default:
		e := err.Error()
		out.SSLError = &e
	}
	return out
}

var hostRe = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func normHost(h string) string { return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".") }

// ---------- handlers ----------

func (a *API) listRoutes(w http.ResponseWriter, r *http.Request) {
	a.routes.mu.Lock()
	list := make([]Route, 0, len(a.routes.routes))
	for _, rt := range a.routes.routes {
		list = append(list, rt)
	}
	a.routes.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Host < list[j].Host })
	out := make([]RouteWithStatus, 0, len(list))
	for _, rt := range list {
		out = append(out, a.routes.withStatus(r.Context(), rt))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) getRoute(w http.ResponseWriter, r *http.Request) {
	host := normHost(r.PathValue("host"))
	a.routes.mu.Lock()
	rt, ok := a.routes.routes[host]
	a.routes.mu.Unlock()
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no route for "+host)
		return
	}
	writeJSON(w, http.StatusOK, a.routes.withStatus(r.Context(), rt))
}

func (a *API) setRoute(w http.ResponseWriter, r *http.Request) {
	host := normHost(r.PathValue("host"))
	var rt Route
	if !decode(w, r, &rt) {
		return
	}
	if rt.Host != "" && normHost(rt.Host) != host {
		writeErr(w, http.StatusBadRequest, "bad_request", "host in body differs from the path")
		return
	}
	rt.Host = host
	if !hostRe.MatchString(host) {
		writeErr(w, http.StatusBadRequest, "bad_request", "ongeldige hostnaam")
		return
	}
	if strings.HasPrefix(host, "*.") {
		rt.Wildcard = true
	}
	rt.ServerUUID = strings.ToLower(rt.ServerUUID)
	if rt.Port != nil && (*rt.Port < 1 || *rt.Port > 65535) {
		writeErr(w, http.StatusBadRequest, "bad_request", "port invalid")
		return
	}
	if rt.RedirectTo != nil {
		v := normHost(*rt.RedirectTo)
		if v != "" && !hostRe.MatchString(v) {
			writeErr(w, http.StatusBadRequest, "bad_request", "redirect_to invalid")
			return
		}
		rt.RedirectTo = &v
	}
	if rt.DNSChallenge != nil && (rt.DNSChallenge.Provider != "cloudflare" || rt.DNSChallenge.APIToken == "") {
		writeErr(w, http.StatusBadRequest, "bad_request", "dns_challenge invalid")
		return
	}
	if _, ok := a.mgr.Get(rt.ServerUUID); !ok {
		writeErr(w, http.StatusNotFound, "not_found", "server_uuid onbekend op deze node")
		return
	}
	if s, _ := a.mgr.Get(rt.ServerUUID); !s.IsWeb() && (rt.RedirectTo == nil || *rt.RedirectTo == "") {
		if rt.Port == nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "port is required for game servers")
			return
		}
		if err := a.mgr.EnsureGameNetwork(r.Context(), rt.ServerUUID); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	pr, ok := a.routes.toProxy(rt)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_request", "no port and the server has no http_port")
		return
	}
	a.routes.mu.Lock()
	a.routes.routes[host] = rt
	err := a.routes.saveLocked()
	a.routes.mu.Unlock()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	out := a.routes.withStatus(r.Context(), rt)
	if err := a.routes.router.SetRoute(r.Context(), pr); err != nil {
		// Opgeslagen; de volgende Sync probeert het opnieuw.
		a.log.Warn("route naar Caddy mislukt", "host", host, "err", err)
		e := "router: " + err.Error()
		out.SSLError = &e
	} else {
		out = a.routes.withStatus(r.Context(), rt)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) removeRoute(w http.ResponseWriter, r *http.Request) {
	host := normHost(r.PathValue("host"))
	a.routes.mu.Lock()
	_, ok := a.routes.routes[host]
	if ok {
		delete(a.routes.routes, host)
	}
	err := a.routes.saveLocked()
	a.routes.mu.Unlock()
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "no route for "+host)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if err := a.routes.router.RemoveRoute(r.Context(), host); err != nil && !errors.Is(err, proxy.ErrNotFound) {
		a.log.Warn("route uit Caddy halen mislukt", "host", host, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}
