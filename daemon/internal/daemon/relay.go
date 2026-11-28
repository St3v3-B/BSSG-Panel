package daemon

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"panel/daemon/internal/api"
	"panel/daemon/internal/relay"
	"panel/daemon/internal/store"
	"panel/daemon/proxy"
)

// relaySvc verbindt de relay met de daemon: config van het panel (GET /api/remote/relay, bewaard in
// state/relay.json zodat de tunnel ook zonder panel na een herstart weer opkomt), de edge-routes in
// de Router, en de statusmeldingen van de tunnel naar het panel.
type relaySvc struct {
	d      *Daemon
	edge   *relay.Edge
	client *relay.Client
	path   string

	mu      sync.Mutex
	last    relay.Config
	fetchMu sync.Mutex
}

func newRelaySvc(d *Daemon) *relaySvc {
	s := &relaySvc{d: d, path: filepath.Join(d.cfg.DataDir, "state", "relay.json")}
	s.edge = &relay.Edge{Self: d.cfg.NodeDomain, Dial: d.cfg.RelayCaddyDial, Log: d.log, PingInterval: d.deps.RelayPing}
	s.edge.Refresh = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Refresh(ctx)
	}
	s.client = &relay.Client{
		Self: d.cfg.NodeDomain, Web: d.cfg.RelayWebUpstream, Log: d.log,
		RootCAs: d.deps.RelayRoots, DialContext: d.deps.RelayDial,
		MinBackoff: d.deps.RelayMinBackoff, MaxBackoff: d.deps.RelayMaxBackoff, PingInterval: d.deps.RelayPing,
		OnChange: func(relay.Status) { s.report() },
	}
	return s
}

// load: de laatst bekende config (bij de start, vóór het panel antwoordt).
func (s *relaySvc) load() {
	var c relay.Config
	if err := store.ReadJSON(s.path, &c); err == nil {
		s.apply(context.Background(), c, false)
	}
}

// Refresh haalt de config bij het panel en past hem toe.
func (s *relaySvc) Refresh(ctx context.Context) error {
	s.fetchMu.Lock()
	defer s.fetchMu.Unlock()
	var c relay.Config
	found, err := s.d.panel.RelayConfig(ctx, &c)
	if err != nil {
		return err
	}
	if !found {
		c = relay.Config{}
	}
	s.apply(ctx, c, true)
	return nil
}

func (s *relaySvc) apply(ctx context.Context, c relay.Config, save bool) {
	s.mu.Lock()
	s.last = c
	s.mu.Unlock()
	if save {
		if err := store.WriteJSON(s.path, c); err != nil {
			s.d.log.Warn("relay.json opslaan mislukt", "err", err)
		}
	}
	if s.edge.SetClients(c.Clients) {
		sctx, cancel := context.WithTimeout(ctx, time.Minute)
		if err := s.d.routes.Sync(sctx); err != nil {
			s.d.log.Warn("syncing routes after relay change failed", "err", err)
			s.d.needSync.Store(true)
		}
		cancel()
	}
	if c.Edge != nil && c.Edge.Secret != "" && c.Edge.URL != "" {
		e := *c.Edge
		s.client.Set(&e)
	} else {
		s.client.Set(nil)
	}
}

// report meldt de tunnelstatus van deze node (als client) aan het panel.
func (s *relaySvc) report() {
	if !s.client.Active() {
		return
	}
	st := s.client.Status()
	s.d.panel.ReportRelay(map[string]any{
		"edge_node_id": st.EdgeNodeID, "connected": st.Connected, "connected_at": st.ConnectedAt,
		"latency_ms": st.LatencyMs, "last_error": st.LastError, "last_error_at": st.LastErrorAt,
		"reconnects": st.Reconnects, "http_mode": s.d.cfg.HTTPMode,
	})
}

// loop: periodiek de config opnieuw ophalen en de status melden.
func (s *relaySvc) loop() {
	defer s.d.wg.Done()
	iv := s.d.deps.RelayInterval
	if iv == 0 {
		iv = time.Minute
	}
	first := true
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		if err := s.Refresh(ctx); err != nil && first {
			s.d.log.Warn("relay config from panel failed; using the saved one", "err", err)
		}
		cancel()
		if !first {
			s.report()
		}
		first = false
		select {
		case <-s.d.stop:
			return
		case <-time.After(iv):
		}
	}
}

func (s *relaySvc) close() {
	s.client.Close()
	s.edge.Close()
}

// ---- api.Relay ----

type relayHostStatus struct {
	Host      string  `json:"host"`
	SSLStatus string  `json:"ssl_status"`
	SSLError  *string `json:"ssl_error"`
}

type relayClientState struct {
	relay.ClientStatus
	SSL []relayHostStatus `json:"ssl,omitempty"`
}

type relayState struct {
	HTTPMode string             `json:"http_mode"`
	Edge     *relay.Status      `json:"edge"`
	Clients  []relayClientState `json:"clients"`
}

func (s *relaySvc) State(ctx context.Context, withSSL bool) any {
	out := relayState{HTTPMode: s.d.cfg.HTTPMode, Clients: []relayClientState{}}
	if s.client.Active() {
		st := s.client.Status()
		out.Edge = &st
	}
	for _, c := range s.edge.Status() {
		cs := relayClientState{ClientStatus: c}
		if withSSL {
			for _, h := range c.Hosts {
				hs := relayHostStatus{Host: h, SSLStatus: string(proxy.SSLPending)}
				sctx, cancel := context.WithTimeout(ctx, 8*time.Second)
				st, err := s.d.deps.Router.Status(sctx, h)
				cancel()
				switch {
				case err == nil:
					hs.SSLStatus = string(st.SSL)
					if st.Error != "" {
						e := st.Error
						hs.SSLError = &e
					}
				case !errors.Is(err, proxy.ErrNotFound):
					e := err.Error()
					hs.SSLError = &e
				}
				cs.SSL = append(cs.SSL, hs)
			}
			sort.Slice(cs.SSL, func(i, j int) bool { return cs.SSL[i].Host < cs.SSL[j].Host })
		}
		out.Clients = append(out.Clients, cs)
	}
	return out
}

func (s *relaySvc) Tunnel(w http.ResponseWriter, r *http.Request) { s.edge.TunnelHandler(w, r) }

var _ api.Relay = (*relaySvc)(nil)
