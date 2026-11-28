package relay

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"

	"panel/daemon/proxy"
)

// Edge is de kant van A: accepteert tunnels van de toegewezen clients en stuurt hun
// hostnamen erdoorheen.
type Edge struct {
	// Self is de NODE_DOMAIN van deze node (deel van de handtekening).
	Self string
	// Dial is het adres waarop Caddy de relay-socket bereikt (Upstream.Dial, bv. unix//run/panel/relay.sock).
	Dial string
	Log  *slog.Logger
	// Refresh haalt de relay-config opnieuw bij het panel; aangeroepen (hooguit eens per
	// 10 s) als een onbekende node een tunnel opent. Mag nil zijn.
	Refresh func()
	// PingInterval voor de latency-meting (standaard 15 s).
	PingInterval time.Duration

	mu          sync.Mutex
	clients     map[int]*edgeClient
	nonces      map[string]time.Time
	lastRefresh time.Time
}

type edgeClient struct {
	cfg   ClientConfig
	hosts map[string]bool // exacte hostnamen, incl. de fqdn
	wild  map[string]bool // ".example.nl" voor "*.example.nl"

	sess        *yamux.Session
	rp          *httputil.ReverseProxy
	tr          *http.Transport
	connectedAt time.Time
	remote      string
	rtt         time.Duration
	lastErr     string
	lastErrAt   time.Time
}

// ClientStatus is één client in GET /api/relay (openapi.yaml RelayClientStatus, zonder SSL).
type ClientStatus struct {
	NodeID      int        `json:"node_id"`
	Fqdn        string     `json:"fqdn"`
	Connected   bool       `json:"connected"`
	ConnectedAt *time.Time `json:"connected_at"`
	LatencyMs   *float64   `json:"latency_ms"`
	Remote      string     `json:"remote,omitempty"`
	LastError   *string    `json:"last_error"`
	LastErrorAt *time.Time `json:"last_error_at"`
	Hosts       []string   `json:"hosts"`
}

var hostRe = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func (e *Edge) log() *slog.Logger {
	if e.Log == nil {
		return slog.Default()
	}
	return e.Log
}

func sameClient(a, b ClientConfig) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// SetClients vervangt de lijst met clients. Verwijderde clients en clients met een ander
// geheim of een ander fqdn worden losgekoppeld. Geeft true als de routes veranderd zijn.
func (e *Edge) SetClients(list []ClientConfig) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.clients == nil {
		e.clients = map[int]*edgeClient{}
	}
	changed := false
	seen := map[int]bool{}
	for _, cc := range list {
		if cc.NodeID <= 0 || cc.Secret == "" {
			continue
		}
		cc.Fqdn = normHost(cc.Fqdn)
		seen[cc.NodeID] = true
		old := e.clients[cc.NodeID]
		if old != nil && sameClient(old.cfg, cc) {
			continue
		}
		changed = true
		nc := &edgeClient{cfg: cc, hosts: map[string]bool{}, wild: map[string]bool{}}
		if hostRe.MatchString(cc.Fqdn) && !strings.HasPrefix(cc.Fqdn, "*.") {
			nc.hosts[cc.Fqdn] = true
		}
		for _, h := range cc.Hosts {
			hn := normHost(h.Host)
			if !hostRe.MatchString(hn) {
				continue
			}
			if strings.HasPrefix(hn, "*.") {
				nc.wild[hn[1:]] = true
			} else {
				nc.hosts[hn] = true
			}
		}
		if old != nil {
			if old.cfg.Secret == cc.Secret && old.cfg.Fqdn == cc.Fqdn {
				// Alleen de hostnamen zijn anders: de tunnel blijft staan.
				nc.sess, nc.rp, nc.tr, nc.connectedAt, nc.remote, nc.rtt = old.sess, old.rp, old.tr, old.connectedAt, old.remote, old.rtt
				nc.lastErr, nc.lastErrAt = old.lastErr, old.lastErrAt
			} else if old.sess != nil {
				_ = old.sess.Close()
			}
		}
		e.clients[cc.NodeID] = nc
	}
	for id, c := range e.clients {
		if !seen[id] {
			changed = true
			if c.sess != nil {
				_ = c.sess.Close()
			}
			delete(e.clients, id)
		}
	}
	return changed
}

// Routes zijn de Caddy-routes van alle clients (fqdn + hostnamen) naar de relay-socket.
func (e *Edge) Routes() []proxy.Route {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []proxy.Route
	fqdns := map[string]bool{}
	for _, c := range e.clients {
		fqdns[c.cfg.Fqdn] = true
	}
	for _, c := range e.clients {
		dns := map[string]*proxy.DNSChallenge{}
		for _, h := range c.cfg.Hosts {
			if h.DNSChallenge != nil && h.DNSChallenge.APIToken != "" {
				dns[normHost(h.Host)] = &proxy.DNSChallenge{Provider: h.DNSChallenge.Provider, APIToken: h.DNSChallenge.APIToken}
			}
		}
		add := func(h string) {
			out = append(out, proxy.Route{Host: h, Wildcard: strings.HasPrefix(h, "*."), DNSChallenge: dns[h], Upstream: proxy.Upstream{Dial: e.Dial}})
		}
		for h := range c.hosts {
			if h == normHost(e.Self) || (h != c.cfg.Fqdn && fqdns[h]) {
				continue
			}
			add(h)
		}
		for w := range c.wild {
			add("*" + w)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Host < out[j].Host })
	return out
}

// lookup: de client van een hostnaam (exact, anders wildcard op één label).
func (e *Edge) lookup(host string) *edgeClient {
	// Het node-domein van een client gaat altijd voor (een domein mag nooit dat van een andere node kapen).
	for _, c := range e.clients {
		if c.cfg.Fqdn == host {
			return c
		}
	}
	if e.isFqdnLocked(host) {
		return nil
	}
	for _, c := range e.clients {
		if c.hosts[host] {
			return c
		}
	}
	if i := strings.IndexByte(host, '.'); i > 0 {
		suf := host[i:]
		for _, c := range e.clients {
			if c.wild[suf] {
				return c
			}
		}
	}
	return nil
}

func jsonErr(w http.ResponseWriter, code int, errCode, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": errCode, "message": msg})
}

// ServeHTTP is de relay-socket: Caddy levert hier de hostnamen van de clients af.
func (e *Edge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := normHost(r.Host)
	e.mu.Lock()
	c := e.lookup(host)
	var rp *httputil.ReverseProxy
	if c != nil && c.sess != nil && !c.sess.IsClosed() {
		rp = c.rp
	}
	e.mu.Unlock()
	switch {
	case c == nil:
		jsonErr(w, http.StatusMisdirectedRequest, "unknown_host", "this host is not relayed by this node")
	case rp == nil:
		jsonErr(w, http.StatusBadGateway, "relay_offline", "the node behind this relay is not connected")
	default:
		rp.ServeHTTP(w, r)
	}
}

func (e *Edge) recordErr(id int, msg string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if c := e.clients[id]; c != nil {
		c.lastErr, c.lastErrAt = msg, time.Now()
	}
}

func (e *Edge) maybeRefresh() {
	if e.Refresh == nil {
		return
	}
	e.mu.Lock()
	if time.Since(e.lastRefresh) < 10*time.Second {
		e.mu.Unlock()
		return
	}
	e.lastRefresh = time.Now()
	e.mu.Unlock()
	e.Refresh()
}

// isFqdnLocked: de hostnaam is het eigen node-domein van deze edge (nooit doorsturen).
func (e *Edge) isFqdnLocked(host string) bool { return host == normHost(e.Self) }

var nonceRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// useNonce: true als de nonce nieuw is (replay-bescherming binnen MaxSkew).
func (e *Edge) useNonce(n string, now time.Time) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.nonces == nil {
		e.nonces = map[string]time.Time{}
	}
	for k, t := range e.nonces {
		if now.Sub(t) > 2*MaxSkew {
			delete(e.nonces, k)
		}
	}
	if _, ok := e.nonces[n]; ok {
		return false
	}
	e.nonces[n] = now
	return true
}

func (e *Edge) secretOf(id int) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.clients[id]
	if c == nil {
		return "", false
	}
	return c.cfg.Secret, true
}

// TunnelHandler is GET /api/relay/tunnel: websocket-upgrade na een geldige handtekening.
func (e *Edge) TunnelHandler(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.Header.Get(HdrNode))
	ts, nonce, sig := r.Header.Get(HdrTime), r.Header.Get(HdrNonce), r.Header.Get(HdrSig)
	if err != nil || id <= 0 || !nonceRe.MatchString(nonce) || sig == "" {
		jsonErr(w, http.StatusUnauthorized, "unauthorized", "missing or invalid relay headers")
		return
	}
	secret, ok := e.secretOf(id)
	if !ok {
		// Misschien net toegewezen: config opnieuw ophalen en nog één keer kijken.
		e.maybeRefresh()
		if secret, ok = e.secretOf(id); !ok {
			jsonErr(w, http.StatusForbidden, "not_a_relay_client", "this node is not assigned to relay through this node")
			return
		}
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	now := time.Now()
	if err != nil || now.Sub(time.Unix(sec, 0)).Abs() > MaxSkew {
		e.recordErr(id, "clock skew too large or invalid time")
		jsonErr(w, http.StatusUnauthorized, "unauthorized", "invalid or stale X-Relay-Time (check the clock)")
		return
	}
	if !equal(sig, clientSig(secret, e.Self, id, ts, nonce)) {
		e.recordErr(id, "invalid signature (wrong relay secret?)")
		jsonErr(w, http.StatusUnauthorized, "unauthorized", "invalid relay signature")
		return
	}
	if !e.useNonce(nonce, now) {
		jsonErr(w, http.StatusUnauthorized, "unauthorized", "nonce reused")
		return
	}
	up := websocket.Upgrader{
		ReadBufferSize: 32 << 10, WriteBufferSize: 32 << 10,
		CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" },
	}
	ws, err := up.Upgrade(w, r, http.Header{HdrProof: {edgeProof(secret, e.Self, id, nonce)}})
	if err != nil {
		return // Upgrade heeft al geantwoord
	}
	sess, err := yamux.Server(newWSConn(ws), yamuxConfig())
	if err != nil {
		ws.Close()
		return
	}
	remote := r.Header.Get("X-Forwarded-For")
	if remote == "" {
		remote = r.RemoteAddr
	}
	if !e.attach(id, secret, sess, remote) {
		_ = sess.Close()
		return
	}
	e.log().Info("relay tunnel connected", "node", id, "remote", remote)
	go e.watch(id, sess)
}

func (e *Edge) attach(id int, secret string, sess *yamux.Session, remote string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.clients[id]
	if c == nil || c.cfg.Secret != secret {
		return false // tussendoor ingetrokken
	}
	if c.sess != nil {
		_ = c.sess.Close()
	}
	tr := &http.Transport{
		DialContext:         func(context.Context, string, string) (net.Conn, error) { return sess.Open() },
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     60 * time.Second,
		DisableCompression:  true,
	}
	c.sess, c.tr, c.remote, c.connectedAt, c.rtt = sess, tr, remote, time.Now(), 0
	c.lastErr = ""
	c.rp = &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "http"
			req.URL.Host = req.Host
		},
		Transport:     tr,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			jsonErr(w, http.StatusBadGateway, "relay_error", err.Error())
		},
	}
	return true
}

func (e *Edge) watch(id int, sess *yamux.Session) {
	iv := e.PingInterval
	if iv == 0 {
		iv = 15 * time.Second
	}
	t := time.NewTicker(iv)
	defer t.Stop()
	ping := func() {
		if d, err := sess.Ping(); err == nil {
			e.mu.Lock()
			if c := e.clients[id]; c != nil && c.sess == sess {
				c.rtt = d
			}
			e.mu.Unlock()
		}
	}
	ping()
	for {
		select {
		case <-sess.CloseChan():
			e.mu.Lock()
			if c := e.clients[id]; c != nil && c.sess == sess {
				c.sess, c.rp = nil, nil
				if c.tr != nil {
					c.tr.CloseIdleConnections()
				}
				c.lastErr, c.lastErrAt = "tunnel closed", time.Now()
			}
			e.mu.Unlock()
			e.log().Info("relay tunnel closed", "node", id)
			return
		case <-t.C:
			ping()
		}
	}
}

// Status geeft de toestand van alle clients, op node-id.
func (e *Edge) Status() []ClientStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]ClientStatus, 0, len(e.clients))
	for id, c := range e.clients {
		st := ClientStatus{NodeID: id, Fqdn: c.cfg.Fqdn, Remote: c.remote, Hosts: []string{}}
		if c.sess != nil && !c.sess.IsClosed() {
			st.Connected = true
			t := c.connectedAt.UTC()
			st.ConnectedAt = &t
			if c.rtt > 0 {
				ms := float64(c.rtt.Microseconds()) / 1000
				st.LatencyMs = &ms
			}
		}
		if c.lastErr != "" {
			m, t := c.lastErr, c.lastErrAt.UTC()
			st.LastError, st.LastErrorAt = &m, &t
		}
		for h := range c.hosts {
			st.Hosts = append(st.Hosts, h)
		}
		for w := range c.wild {
			st.Hosts = append(st.Hosts, "*"+w)
		}
		sort.Strings(st.Hosts)
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].NodeID < out[j].NodeID })
	return out
}

// Close verbreekt alle tunnels.
func (e *Edge) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, c := range e.clients {
		if c.sess != nil {
			_ = c.sess.Close()
		}
	}
}

// DropAll verbreekt alle tunnels (de clients verbinden opnieuw); voor tests en na een geheimwissel.
func (e *Edge) DropAll() { e.Close() }
