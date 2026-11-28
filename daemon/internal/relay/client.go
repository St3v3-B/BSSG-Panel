package relay

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

// Client is de kant van B: houdt de tunnel naar de toegewezen edge open en beantwoordt
// de verzoeken die erdoor komen.
type Client struct {
	// Self is de NODE_DOMAIN van deze node: die verzoeken gaan naar API.
	Self string
	// API is de daemon-API van deze node.
	API http.Handler
	// Web is de lokale Caddy voor alle andere hostnamen (zonder TLS):
	// "unix:///run/panel/caddy-relay.sock" of "http://127.0.0.1:<poort>". Leeg = 502.
	Web string
	// RootCAs voor het certificaat van de edge (nil = systeem-CA's).
	RootCAs *x509.CertPool
	// DialContext vervangt de TCP-dial naar de edge (tests).
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
	Log         *slog.Logger
	// OnChange wordt (in een eigen goroutine) aangeroepen bij verbinden en verbreken.
	OnChange func(Status)
	// MinBackoff/MaxBackoff voor opnieuw verbinden (standaard 1 s / 30 s).
	MinBackoff, MaxBackoff time.Duration
	// PingInterval voor de latency (standaard 15 s).
	PingInterval time.Duration

	mu     sync.Mutex
	cfg    *EdgeConfig
	cancel context.CancelFunc
	done   chan struct{}
	st     Status
	web    http.Handler
}

// Status is de toestand van de tunnel vanaf B gezien (panel-remote RelayStatusReport).
type Status struct {
	EdgeNodeID  int        `json:"edge_node_id"`
	EdgeURL     string     `json:"edge_url"`
	Connected   bool       `json:"connected"`
	ConnectedAt *time.Time `json:"connected_at"`
	LatencyMs   *float64   `json:"latency_ms"`
	LastError   *string    `json:"last_error"`
	LastErrorAt *time.Time `json:"last_error_at"`
	Reconnects  int        `json:"reconnects"`
}

// ErrProof: de edge kon niet bewijzen dat hij de door het panel aangewezen node is.
var ErrProof = errors.New("relay: the edge did not prove the shared secret: not the relay node assigned by the panel")

func (c *Client) log() *slog.Logger {
	if c.Log == nil {
		return slog.Default()
	}
	return c.Log
}

func sameEdge(a, b *EdgeConfig) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// Set start, wijzigt of stopt (nil) de tunnel.
func (c *Client) Set(cfg *EdgeConfig) {
	c.mu.Lock()
	if sameEdge(c.cfg, cfg) {
		c.mu.Unlock()
		return
	}
	cancel, done := c.cancel, c.done
	c.cfg, c.cancel, c.done = nil, nil, nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.st = Status{}
	if cfg == nil {
		return
	}
	cp := *cfg
	ctx, cancel2 := context.WithCancel(context.Background())
	c.cfg, c.cancel, c.done = &cp, cancel2, make(chan struct{})
	c.st = Status{EdgeNodeID: cp.NodeID, EdgeURL: cp.URL}
	go c.run(ctx, cp, c.done)
}

// Active: er is een edge ingesteld.
func (c *Client) Active() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg != nil
}

// Status geeft de huidige toestand.
func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.st
}

// Close stopt de tunnel.
func (c *Client) Close() { c.Set(nil) }

func (c *Client) update(fn func(*Status)) {
	c.mu.Lock()
	fn(&c.st)
	st := c.st
	c.mu.Unlock()
	if c.OnChange != nil {
		go c.OnChange(st)
	}
}

func (c *Client) run(ctx context.Context, cfg EdgeConfig, done chan struct{}) {
	defer close(done)
	minB, maxB := c.MinBackoff, c.MaxBackoff
	if minB == 0 {
		minB = time.Second
	}
	if maxB == 0 {
		maxB = 30 * time.Second
	}
	backoff := minB
	for attempt := 0; ; attempt++ {
		start := time.Now()
		err := c.connect(ctx, cfg, attempt > 0)
		if ctx.Err() != nil {
			return
		}
		msg := "tunnel closed"
		if err != nil {
			msg = err.Error()
		}
		c.log().Warn("relay tunnel down; reconnecting", "edge", cfg.URL, "err", msg, "in", backoff)
		c.update(func(s *Status) {
			now := time.Now().UTC()
			s.Connected, s.ConnectedAt, s.LatencyMs = false, nil, nil
			s.LastError, s.LastErrorAt = &msg, &now
		})
		if time.Since(start) > 30*time.Second {
			backoff = minB
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxB)
	}
}

func tunnelURL(raw string) (string, string, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" {
		return "", "", fmt.Errorf("relay: invalid edge URL %q", raw)
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http": // alleen tests
		u.Scheme = "ws"
	default:
		return "", "", fmt.Errorf("relay: invalid edge URL %q", raw)
	}
	u.Path = TunnelPath
	return u.String(), u.Hostname(), nil
}

// connect zet één tunnel op en blokkeert tot hij wegvalt.
func (c *Client) connect(ctx context.Context, cfg EdgeConfig, reconnect bool) error {
	wsURL, host, err := tunnelURL(cfg.URL)
	if err != nil {
		return err
	}
	nb := make([]byte, 16)
	_, _ = rand.Read(nb)
	nonce := hex.EncodeToString(nb)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	hdr := http.Header{
		HdrNode:  {strconv.Itoa(cfg.ClientID)},
		HdrTime:  {ts},
		HdrNonce: {nonce},
		HdrSig:   {clientSig(cfg.Secret, cfg.Fqdn, cfg.ClientID, ts, nonce)},
	}
	d := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		TLSClientConfig:  &tls.Config{RootCAs: c.RootCAs, ServerName: host, MinVersion: tls.VersionTLS12},
		NetDialContext:   c.DialContext,
		ReadBufferSize:   32 << 10, WriteBufferSize: 32 << 10,
	}
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	ws, resp, err := d.DialContext(dctx, wsURL, hdr)
	cancel()
	if err != nil {
		if resp != nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
			resp.Body.Close()
			return fmt.Errorf("relay: edge refused the tunnel: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
		}
		return fmt.Errorf("relay: %w", err)
	}
	if !equal(resp.Header.Get(HdrProof), edgeProof(cfg.Secret, cfg.Fqdn, cfg.ClientID, nonce)) {
		ws.Close()
		return ErrProof
	}
	sess, err := yamux.Client(newWSConn(ws), yamuxConfig())
	if err != nil {
		ws.Close()
		return err
	}
	defer sess.Close()
	srv := &http.Server{Handler: c.handler(), ReadHeaderTimeout: 30 * time.Second, ErrorLog: log.New(io.Discard, "", 0)}
	go func() { _ = srv.Serve(sess) }()
	defer srv.Close()
	c.log().Info("relay tunnel connected", "edge", cfg.URL)
	c.update(func(s *Status) {
		now := time.Now().UTC()
		s.Connected, s.ConnectedAt, s.LastError, s.LastErrorAt = true, &now, nil, nil
		if reconnect {
			s.Reconnects++
		}
	})
	iv := c.PingInterval
	if iv == 0 {
		iv = 15 * time.Second
	}
	t := time.NewTicker(iv)
	defer t.Stop()
	ping := func() {
		if rtt, err := sess.Ping(); err == nil {
			ms := float64(rtt.Microseconds()) / 1000
			c.mu.Lock()
			c.st.LatencyMs = &ms
			c.mu.Unlock()
		}
	}
	ping()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-sess.CloseChan():
			return errors.New("relay: tunnel closed by the edge or the network")
		case <-t.C:
			ping()
		}
	}
}

func (c *Client) handler() http.Handler {
	c.mu.Lock()
	if c.web == nil {
		c.web = webProxy(c.Web)
	}
	web := c.web
	c.mu.Unlock()
	self := normHost(c.Self)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if normHost(r.Host) == self {
			if c.API == nil {
				jsonErr(w, http.StatusBadGateway, "no_api", "daemon API not available")
				return
			}
			c.API.ServeHTTP(w, r)
			return
		}
		if web == nil {
			jsonErr(w, http.StatusBadGateway, "no_web", "no local web proxy configured on this node")
			return
		}
		web.ServeHTTP(w, r)
	})
}

// webProxy: reverse proxy naar de lokale Caddy (Host blijft staan).
func webProxy(addr string) http.Handler {
	if addr == "" {
		return nil
	}
	tr := &http.Transport{MaxIdleConnsPerHost: 64, IdleConnTimeout: 60 * time.Second, DisableCompression: true}
	target := addr
	if p, ok := strings.CutPrefix(addr, "unix://"); ok {
		tr.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", p)
		}
		target = "http://relay-web"
	}
	u, err := url.Parse(target)
	if err != nil {
		return nil
	}
	return &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme, req.URL.Host = u.Scheme, u.Host
		},
		Transport:     tr,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			jsonErr(w, http.StatusBadGateway, "web_unreachable", "local web proxy: "+err.Error())
		},
	}
}
