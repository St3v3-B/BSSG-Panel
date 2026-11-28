package daemon

import (
	"context"
	"sync"
	"time"

	"panel/daemon/proxy"
)

// npmSvc verbindt de NPM-koppeling (proxy.NPM, alleen bij HTTP_MODE=npm) met het panel.
//
// Keuze: de inloggegevens van NPM staan alleen in het panel (versleuteld in nodes.npm_password_enc) en de daemon
// haalt ze op met zijn node-token (GET /api/remote/npm: bij de start, elke minuut en na POST /api/npm/refresh),
// net als het relay-geheim. Ze staan nooit in panel.env en worden niet op schijf bewaard: NPM onthoudt de proxy
// hosts zelf, dus na een herstart zonder panel blijft alles werken tot de daemon het panel weer bereikt.
type npmSvc struct {
	d      *Daemon
	router *proxy.NPM // nil als HTTP_MODE niet npm is

	fetchMu    sync.Mutex
	mu         sync.Mutex
	configured bool
	lastReport time.Time
}

// npmRemoteConfig is het antwoord van GET /api/remote/npm.
type npmRemoteConfig struct {
	Enabled bool `json:"enabled"`
	proxy.NPMSettings
}

func newNPMSvc(d *Daemon, r *proxy.NPM) *npmSvc { return &npmSvc{d: d, router: r} }

// npmState is GET /api/npm.
type npmState struct {
	HTTPMode   string `json:"http_mode"`
	Configured bool   `json:"configured"`
	proxy.NPMStatus
}

func (s *npmSvc) State() any {
	s.mu.Lock()
	conf := s.configured
	s.mu.Unlock()
	st := proxy.NPMStatus{State: proxy.NPMStateUnconfigured, Conflicts: []string{}, Hosts: []proxy.NPMHostStatus{}}
	if s.router != nil {
		st = s.router.NPMStatus()
	}
	return npmState{HTTPMode: s.d.cfg.HTTPMode, Configured: conf, NPMStatus: st}
}

// Refresh haalt de instellingen bij het panel en past ze toe (start een ronde).
func (s *npmSvc) Refresh(ctx context.Context) error {
	s.fetchMu.Lock()
	defer s.fetchMu.Unlock()
	var c npmRemoteConfig
	found, err := s.d.panel.NPMConfig(ctx, &c)
	if err != nil {
		return err
	}
	on := found && c.Enabled && c.URL != ""
	s.mu.Lock()
	s.configured = on
	s.mu.Unlock()
	if s.router != nil {
		if on {
			st := c.NPMSettings
			s.router.Configure(&st)
		} else {
			s.router.Configure(nil)
		}
	}
	return nil
}

func (s *npmSvc) Test(ctx context.Context, url, email, password string) any {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return proxy.TestNPM(ctx, proxy.NPMSettings{URL: url, Email: email, Password: password}, s.d.cfg.Instance, s.d.deps.NPMHTTPClient)
}

// report meldt de toestand aan het panel (bij een wijziging en elke 10 minuten).
func (s *npmSvc) report(force bool) {
	s.mu.Lock()
	if !force && time.Since(s.lastReport) < 10*time.Minute {
		s.mu.Unlock()
		return
	}
	s.lastReport = time.Now()
	s.mu.Unlock()
	s.d.panel.ReportNPM(s.State())
}

// loop: periodiek de instellingen ophalen; de ronde zelf draait in router.Run.
func (s *npmSvc) loop() {
	defer s.d.wg.Done()
	iv := s.d.deps.NPMInterval
	if iv == 0 {
		iv = time.Minute
	}
	if s.router != nil {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() { <-s.d.stop; cancel() }()
		s.d.wg.Add(1)
		go func() {
			defer s.d.wg.Done()
			s.router.Run(ctx)
		}()
	}
	first := true
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		if err := s.Refresh(ctx); err != nil && first {
			s.d.log.Warn("npm settings from panel failed", "err", err)
		}
		cancel()
		if s.router != nil {
			s.report(first)
		}
		first = false
		select {
		case <-s.d.stop:
			return
		case <-time.After(iv):
		}
	}
}
