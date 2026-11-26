package proxy

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Afspraken met de Caddy-basisconfig (deploy/caddy/Caddyfile).
const (
	// DefaultServerName is de naam van de HTTPS-server in de Caddyfile
	// (`servers :443 { name panel }`); daar landen de dynamische routes.
	DefaultServerName = "panel"
	// RouteIDPrefix: elke dynamische route heeft "@id": RouteIDPrefix + host
	// (een "*" in een wildcard-host wordt "_"). Routes zonder dit prefix zijn vast
	// en worden nooit gewijzigd of verwijderd.
	RouteIDPrefix = "panel-dyn-"

	maxAttempts = 5
)

// Metadata die we in een vars-handler aan het begin van elke dynamische route
// meegeven, zodat de router stateloos blijft (o.a. voor de netwerk-koppeling).
const (
	varHost    = "panel_host"
	varServer  = "panel_server_uuid"
	varNetwork = "panel_network"
)

// CaddyOptions zijn extra instellingen naast Config, vooral voor tests.
type CaddyOptions struct {
	// ServerName, standaard DefaultServerName.
	ServerName string
	// TLSAddr overschrijft Config.TLSAddr (tests).
	TLSAddr string
	// HTTPClient voor de admin-API; standaard een client met 15 s timeout
	// (bij een unix://-AdminURL met een transport naar de socket).
	HTTPClient *http.Client
	// Docker voor de netwerk-koppeling; standaard de Docker-API via DOCKER_HOST
	// of /var/run/docker.sock. Alleen gebruikt als Config.CaddyContainer gezet is.
	Docker Networker
	// ExtraRoots worden naast de systeem-CA's vertrouwd bij de SSL-controle
	// (bv. de staging-root van Let's Encrypt in tests).
	ExtraRoots *x509.CertPool
}

// Caddy is de Router (en HealthChecker) tegen de Caddy admin-API.
type Caddy struct {
	cfg     Config
	admin   string // zonder slash aan het eind
	server  string
	tlsAddr string
	hc      *http.Client
	docker  Networker
	extra   *x509.CertPool

	mu sync.Mutex // serialiseert wijzigingen en Healthy
	// expected: IDs van de dynamische routes die we het laatst hebben gezet.
	// Ontbreken ze in Caddy, dan is Caddy herstart (zie Healthy).
	expected map[string]bool
}

var (
	_ Router        = (*Caddy)(nil)
	_ HealthChecker = (*Caddy)(nil)
)

// DefaultTLSAddr is het standaardadres voor de SSL-controle (CADDY_TLS_ADDR).
const DefaultTLSAddr = "127.0.0.1:443"

// adminClient geeft de basis-URL en HTTP-client voor de admin-API.
//   - unix:///run/panel/caddy-admin.sock (productie): requests naar http://caddy/...
//     over de socket. Caddy doet geen Host-check op een unix-socket.
//   - http://127.0.0.1:<poort> (tests).
func adminClient(adminURL string, hc *http.Client) (string, *http.Client, error) {
	u, err := url.Parse(adminURL)
	if err != nil {
		return "", nil, fmt.Errorf("proxy: ongeldige Caddy admin-URL %q", adminURL)
	}
	switch {
	case u.Scheme == "unix" && u.Path != "" && u.Host == "":
		if hc == nil {
			path := u.Path
			hc = &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "unix", path)
				},
			}}
		}
		return "http://caddy", hc, nil
	case (u.Scheme == "http" || u.Scheme == "https") && u.Host != "":
		if hc == nil {
			hc = &http.Client{Timeout: 15 * time.Second}
		}
		return strings.TrimRight(adminURL, "/"), hc, nil
	}
	return "", nil, fmt.Errorf("proxy: ongeldige Caddy admin-URL %q (verwacht unix:///pad/naar.sock of http://host:poort)", adminURL)
}

// NewCaddy maakt de echte Router tegen de Caddy admin-API (cfg.AdminURL).
// Het resultaat implementeert ook HealthChecker.
func NewCaddy(cfg Config) (Router, error) {
	return NewCaddyWithOptions(cfg, CaddyOptions{})
}

// NewCaddyWithOptions is NewCaddy met extra instellingen.
func NewCaddyWithOptions(cfg Config, opt CaddyOptions) (*Caddy, error) {
	admin, hc, err := adminClient(cfg.AdminURL, opt.HTTPClient)
	if err != nil {
		return nil, err
	}
	c := &Caddy{
		cfg:      cfg,
		admin:    admin,
		server:   opt.ServerName,
		tlsAddr:  opt.TLSAddr,
		hc:       hc,
		docker:   opt.Docker,
		extra:    opt.ExtraRoots,
		expected: map[string]bool{},
	}
	if c.server == "" {
		c.server = DefaultServerName
	}
	if c.tlsAddr == "" {
		c.tlsAddr = cfg.TLSAddr
	}
	if c.tlsAddr == "" {
		c.tlsAddr = DefaultTLSAddr
	}
	if c.docker == nil && cfg.CaddyContainer != "" {
		d, err := NewDockerAPI(os.Getenv("DOCKER_HOST"))
		if err != nil {
			return nil, err
		}
		c.docker = d
	}
	return c, nil
}

// ---- validatie ----

var (
	hostRe  = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	plainRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`) // container- en netwerknamen
)

func normHost(h string) (string, error) {
	h = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
	if len(h) == 0 || len(h) > 253 || !hostRe.MatchString(h) {
		return "", fmt.Errorf("proxy: ongeldige hostnaam %q", h)
	}
	return h, nil
}

func routeID(host string) string { return RouteIDPrefix + strings.ReplaceAll(host, "*", "_") }

func normRoute(r Route) (Route, error) {
	h, err := normHost(r.Host)
	if err != nil {
		return r, err
	}
	r.Host = h
	// Wildcard volgt uit de hostnaam ("*.example.nl"); Wildcard=true zonder "*." is fout.
	if r.Wildcard && !strings.HasPrefix(h, "*.") {
		return r, fmt.Errorf("proxy: %s: Wildcard=true maar de hostnaam begint niet met \"*.\"", h)
	}
	r.Wildcard = strings.HasPrefix(h, "*.")
	if r.RedirectTo != "" {
		t, err := normHost(r.RedirectTo)
		if err != nil || strings.HasPrefix(t, "*.") {
			return r, fmt.Errorf("proxy: %s: ongeldige RedirectTo %q", h, r.RedirectTo)
		}
		if t == h {
			return r, fmt.Errorf("proxy: %s: redirect naar zichzelf", h)
		}
		r.RedirectTo = t
		r.Upstream = Upstream{}
		return r, nil
	}
	u := r.Upstream
	if !plainRe.MatchString(u.Container) {
		return r, fmt.Errorf("proxy: %s: ongeldige upstream-container %q", h, u.Container)
	}
	if u.Port < 1 || u.Port > 65535 {
		return r, fmt.Errorf("proxy: %s: ongeldige upstream-poort %d", h, u.Port)
	}
	if u.Network != "" && !plainRe.MatchString(u.Network) {
		return r, fmt.Errorf("proxy: %s: ongeldig netwerk %q", h, u.Network)
	}
	return r, nil
}

// ---- Caddy-JSON ----

type dynRoute struct {
	id      string
	host    string
	network string
	raw     any // genormaliseerde JSON (map[string]any)
}

func canon(v any) (any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var out any
	return out, json.Unmarshal(b, &out)
}

func buildRoute(r Route) (dynRoute, error) {
	vars := map[string]any{"handler": "vars", varHost: r.Host}
	if r.ServerUUID != "" {
		vars[varServer] = r.ServerUUID
	}
	var h map[string]any
	if r.RedirectTo != "" {
		h = map[string]any{
			"handler":     "static_response",
			"status_code": 308,
			"headers":     map[string][]string{"Location": {"https://" + r.RedirectTo + "{http.request.uri}"}},
		}
	} else {
		if r.Upstream.Network != "" {
			vars[varNetwork] = r.Upstream.Network
		}
		h = map[string]any{
			"handler":   "reverse_proxy",
			"upstreams": []map[string]string{{"dial": net.JoinHostPort(r.Upstream.Container, strconv.Itoa(r.Upstream.Port))}},
		}
	}
	raw, err := canon(map[string]any{
		"@id":      routeID(r.Host),
		"match":    []map[string]any{{"host": []string{r.Host}}},
		"handle":   []any{vars, h},
		"terminal": true,
	})
	if err != nil {
		return dynRoute{}, err
	}
	d := dynRoute{id: routeID(r.Host), host: r.Host, raw: raw}
	if r.RedirectTo == "" {
		d.network = r.Upstream.Network
	}
	return d, nil
}

// split verdeelt de routes van de server in vaste (ongewijzigd, op volgorde) en
// dynamische (op ID), en geeft de hostnamen van de vaste routes.
func split(routes []any) (fixed []any, dyn map[string]dynRoute, fixedHosts map[string]bool) {
	dyn = map[string]dynRoute{}
	fixedHosts = map[string]bool{}
	for _, r := range routes {
		m, _ := r.(map[string]any)
		id, _ := m["@id"].(string)
		if m == nil || !strings.HasPrefix(id, RouteIDPrefix) {
			fixed = append(fixed, r)
			for _, h := range routeHosts(m) {
				fixedHosts[strings.ToLower(h)] = true
			}
			continue
		}
		d := dynRoute{id: id, raw: r}
		if hs := routeHosts(m); len(hs) > 0 {
			d.host = hs[0]
		}
		if hs, _ := m["handle"].([]any); len(hs) > 0 {
			if v, _ := hs[0].(map[string]any); v != nil && v["handler"] == "vars" {
				d.network, _ = v[varNetwork].(string)
				if h, ok := v[varHost].(string); ok {
					d.host = h
				}
			}
		}
		dyn[id] = d
	}
	return fixed, dyn, fixedHosts
}

func routeHosts(m map[string]any) []string {
	var out []string
	ms, _ := m["match"].([]any)
	for _, mm := range ms {
		mmap, _ := mm.(map[string]any)
		hs, _ := mmap["host"].([]any)
		for _, h := range hs {
			if s, ok := h.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// assemble: vaste routes eerst (ongewijzigd, zelfde volgorde), dan exacte hosts,
// dan wildcards (meest specifiek eerst), zodat a.example.nl vóór *.example.nl matcht.
func assemble(fixed []any, dyn map[string]dynRoute) []any {
	ds := make([]dynRoute, 0, len(dyn))
	for _, d := range dyn {
		ds = append(ds, d)
	}
	sort.Slice(ds, func(i, j int) bool {
		wi, wj := strings.HasPrefix(ds[i].host, "*."), strings.HasPrefix(ds[j].host, "*.")
		if wi != wj {
			return !wi
		}
		if wi {
			ni, nj := strings.Count(ds[i].host, "."), strings.Count(ds[j].host, ".")
			if ni != nj {
				return ni > nj
			}
		}
		return ds[i].id < ds[j].id
	})
	out := make([]any, 0, len(fixed)+len(ds))
	out = append(out, fixed...)
	for _, d := range ds {
		out = append(out, d.raw)
	}
	return out
}

// ---- admin-API ----

var errConflict = errors.New("proxy: Caddy-config is tussendoor gewijzigd")

func (c *Caddy) routesPath() string {
	return "/config/apps/http/servers/" + url.PathEscape(c.server) + "/routes"
}

func (c *Caddy) do(ctx context.Context, method, path string, body any, hdr map[string]string) (*http.Response, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.admin+path, rd)
	if err != nil {
		return nil, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("proxy: Caddy admin-API: %w", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, nil, fmt.Errorf("proxy: Caddy admin-API: %w", err)
	}
	return resp, b, nil
}

func (c *Caddy) getRoutes(ctx context.Context) ([]any, string, error) {
	resp, b, err := c.do(ctx, http.MethodGet, c.routesPath(), nil, nil)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("proxy: Caddy GET %s: %s: %s", c.routesPath(), resp.Status, strings.TrimSpace(string(b)))
	}
	var routes []any
	if err := json.Unmarshal(b, &routes); err != nil {
		return nil, "", fmt.Errorf("proxy: Caddy-routes onleesbaar: %w", err)
	}
	if routes == nil {
		return nil, "", fmt.Errorf("proxy: server %q heeft geen routes in de Caddy-config (basisconfig niet geladen?)", c.server)
	}
	return routes, resp.Header.Get("Etag"), nil
}

func (c *Caddy) patchRoutes(ctx context.Context, routes []any, etag string) error {
	hdr := map[string]string{}
	if etag != "" {
		hdr["If-Match"] = etag
	}
	resp, b, err := c.do(ctx, http.MethodPatch, c.routesPath(), routes, hdr)
	if err != nil {
		return err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusPreconditionFailed:
		return errConflict
	default:
		return fmt.Errorf("proxy: Caddy weigert de routes: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
}

// apply leest de huidige routes, laat change de dynamische set aanpassen,
// koppelt netwerken, schrijft het resultaat (alleen als er iets verandert) en
// koppelt overbodige netwerken los. Vaste routes gaan ongewijzigd en op hun plek
// mee terug; met If-Match (ETag) kan er tussendoor niets verloren gaan (412 →
// opnieuw).
func (c *Caddy) apply(ctx context.Context, change func(dyn map[string]dynRoute, fixedHosts map[string]bool) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for attempt := 1; ; attempt++ {
		cur, etag, err := c.getRoutes(ctx)
		if err != nil {
			return err
		}
		fixed, dyn, fixedHosts := split(cur)
		if err := change(dyn, fixedHosts); err != nil {
			return err
		}
		keep, netErr := c.connectNetworks(ctx, dyn)
		next := assemble(fixed, dyn)
		if !reflect.DeepEqual(cur, next) {
			err = c.patchRoutes(ctx, next, etag)
			if errors.Is(err, errConflict) && attempt < maxAttempts {
				continue
			}
			if err != nil {
				return errors.Join(err, netErr)
			}
		}
		c.expected = make(map[string]bool, len(dyn))
		for id := range dyn {
			c.expected[id] = true
		}
		return errors.Join(netErr, c.disconnectNetworks(ctx, keep))
	}
}

// SetRoute voegt een route toe of vervangt die met dezelfde Host.
func (c *Caddy) SetRoute(ctx context.Context, r Route) error {
	r, err := normRoute(r)
	if err != nil {
		return err
	}
	if err := c.checkNetwork(ctx, r); err != nil {
		return err
	}
	d, err := buildRoute(r)
	if err != nil {
		return err
	}
	return c.apply(ctx, func(dyn map[string]dynRoute, fixedHosts map[string]bool) error {
		if fixedHosts[r.Host] {
			return fmt.Errorf("proxy: %s hoort bij een vaste route", r.Host)
		}
		dyn[d.id] = d
		return nil
	})
}

// RemoveRoute haalt de route weg; ErrNotFound als hij niet bestond.
func (c *Caddy) RemoveRoute(ctx context.Context, host string) error {
	h, err := normHost(host)
	if err != nil {
		return ErrNotFound
	}
	id := routeID(h)
	return c.apply(ctx, func(dyn map[string]dynRoute, _ map[string]bool) error {
		if _, ok := dyn[id]; !ok {
			return ErrNotFound
		}
		delete(dyn, id)
		return nil
	})
}

// Sync maakt de dynamische routes exact gelijk aan routes. Ongeldige routes worden
// overgeslagen en in de fout gemeld; de rest wordt wel gezet.
func (c *Caddy) Sync(ctx context.Context, routes []Route) error {
	var errs []error
	want := map[string]dynRoute{}
	for _, r := range routes {
		r, err := normRoute(r)
		if err == nil {
			err = c.checkNetwork(ctx, r)
		}
		var d dynRoute
		if err == nil {
			d, err = buildRoute(r)
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		want[d.id] = d
	}
	err := c.apply(ctx, func(dyn map[string]dynRoute, fixedHosts map[string]bool) error {
		for id := range dyn {
			delete(dyn, id)
		}
		for id, d := range want {
			if fixedHosts[d.host] {
				errs = append(errs, fmt.Errorf("proxy: %s hoort bij een vaste route", d.host))
				continue
			}
			dyn[id] = d
		}
		return nil
	})
	return errors.Join(append(errs, err)...)
}

// Status geeft de SSL-status van één hostnaam; ErrNotFound als er geen route is.
func (c *Caddy) Status(ctx context.Context, host string) (RouteStatus, error) {
	h, err := normHost(host)
	if err != nil {
		return RouteStatus{}, ErrNotFound
	}
	cur, _, err := c.getRoutes(ctx)
	if err != nil {
		return RouteStatus{}, err
	}
	_, dyn, _ := split(cur)
	if _, ok := dyn[routeID(h)]; !ok {
		return RouteStatus{}, ErrNotFound
	}
	st := RouteStatus{Host: h, CheckedAt: time.Now()}
	st.SSL, st.Error = c.checkTLS(ctx, h)
	return st, nil
}

// Healthy faalt als de admin-API niet antwoordt, de server uit de basisconfig
// ontbreekt, of als de dynamische routes die we gezet hebben weg zijn (Caddy is
// herstart tussen twee checks). In dat laatste geval faalt hij één keer, zodat de
// daemon bij de volgende geslaagde check Sync aanroept.
func (c *Caddy) Healthy(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	cur, _, err := c.getRoutes(ctx)
	if err != nil {
		return err
	}
	_, dyn, _ := split(cur)
	missing := 0
	for id := range c.expected {
		if _, ok := dyn[id]; !ok {
			missing++
		}
	}
	if missing > 0 {
		c.expected = map[string]bool{}
		return fmt.Errorf("proxy: %d dynamische route(s) ontbreken in Caddy (herstart?); Sync nodig", missing)
	}
	return nil
}
