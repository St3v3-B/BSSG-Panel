// Package daemon zet alle onderdelen in elkaar: config, Docker, manager, API, Router.
package daemon

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"panel/daemon/internal/api"
	"panel/daemon/internal/auth"
	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/server"
	"panel/daemon/proxy"
)

// Deps zijn de onderdelen die tests kunnen vervangen.
type Deps struct {
	Engine  engine.Engine
	Router  proxy.Router
	Log     *slog.Logger
	Version string
	// Server-opties (tests zetten korte tijden).
	Server server.Config
	// Panel, als gezet, vervangt de standaard panel-client.
	Panel *panel.Client
	// WSAuthTimeout: tijd voor het eerste auth-bericht (standaard 10 s).
	WSAuthTimeout time.Duration
	// SyncInterval voor Router.Sync (standaard 5 min) en HealthInterval (15 s).
	SyncInterval, HealthInterval time.Duration
}

// Daemon is een draaiende daemon.
type Daemon struct {
	cfg    config.Config
	deps   Deps
	log    *slog.Logger
	panel  *panel.Client
	mgr    *server.Manager
	routes *api.Routes
	api    *api.API

	healthy   atomic.Int32 // 0 onbekend, 1 gezond, 2 ongezond
	needSync  atomic.Bool
	httpSrv   []*http.Server
	tcpAddr   string
	stop      chan struct{}
	wg        sync.WaitGroup
	closeOnce sync.Once
}

// DiskQuotaMode: XFS-detectie komt in fase 2.
const DiskQuotaMode = "soft"

// New bouwt de daemon; Start zet hem aan.
func New(cfg config.Config, deps Deps) (*Daemon, error) {
	if deps.Log == nil {
		deps.Log = slog.Default()
	}
	if deps.SyncInterval == 0 {
		deps.SyncInterval = 5 * time.Minute
	}
	if deps.HealthInterval == 0 {
		deps.HealthInterval = 15 * time.Second
	}
	d := &Daemon{cfg: cfg, deps: deps, log: deps.Log, stop: make(chan struct{})}
	d.panel = deps.Panel
	if d.panel == nil {
		d.panel = panel.New(cfg.PanelURL, cfg.NodeToken, deps.Log)
	}
	sc := deps.Server
	sc.DataDir = cfg.DataDir
	sc.Instance = cfg.Instance
	sc.ExtraLabels = cfg.ExtraLabels
	d.mgr = server.NewManager(sc, deps.Engine, d.panel, deps.Log)
	routes, err := api.NewRoutes(filepath.Join(cfg.DataDir, "state", "routes.json"), deps.Router, d.mgr, deps.Log)
	if err != nil {
		return nil, fmt.Errorf("routes.json: %w", err)
	}
	d.routes = routes
	verifier := auth.NewVerifier(d.panel.JWKS, cfg.NodeDomain)
	d.api = api.New(api.Options{NodeToken: cfg.NodeToken, AllowedOrigins: cfg.AllowedOrigins(), AuthTimeout: deps.WSAuthTimeout}, d.mgr, routes, verifier, d.systemInfo, deps.Log)
	return d, nil
}

// Manager geeft de servermanager (voor tests).
func (d *Daemon) Manager() *server.Manager { return d.mgr }

// Handler geeft de HTTP-handler (voor tests).
func (d *Daemon) Handler() http.Handler { return d.api.Handler() }

// TCPAddr is het adres waarop de daemon via TCP luistert.
func (d *Daemon) TCPAddr() string { return d.tcpAddr }

// Start herstelt de staat, synchroniseert de routes en begint te luisteren.
func (d *Daemon) Start(ctx context.Context) error {
	for _, dir := range []string{filepath.Join(d.cfg.DataDir, "volumes"), filepath.Join(d.cfg.DataDir, "state", "servers")} {
		if err := os.MkdirAll(dir, 0o711); err != nil {
			return err
		}
	}
	if err := d.mgr.Recover(ctx); err != nil {
		return fmt.Errorf("staat herstellen: %w", err)
	}
	if err := d.routes.Sync(ctx); err != nil {
		d.log.Warn("routes synchroniseren mislukt", "err", err)
		d.needSync.Store(true)
	}

	h := d.api.Handler()
	if d.cfg.DaemonSocket != "" {
		ln, err := listenUnix(d.cfg.DaemonSocket)
		if err != nil {
			return fmt.Errorf("unix-socket %s: %w", d.cfg.DaemonSocket, err)
		}
		d.serve(ln, h)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(d.cfg.DaemonPort)))
	if err != nil {
		return fmt.Errorf("tcp: %w", err)
	}
	d.tcpAddr = ln.Addr().String()
	d.serve(ln, h)
	d.log.Info("daemon luistert", "tcp", d.tcpAddr, "socket", d.cfg.DaemonSocket, "version", d.deps.Version, "servers", d.mgr.Count())

	d.panel.Hello(d.deps.Version, DiskQuotaMode)
	d.wg.Add(1)
	go d.routerLoop()
	return nil
}

func listenUnix(p string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, err
	}
	if fi, err := os.Lstat(p); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("bestaat al en is geen socket")
		}
		_ = os.Remove(p)
	}
	ln, err := net.Listen("unix", p)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(p, 0o660); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func (d *Daemon) serve(ln net.Listener, h http.Handler) {
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	d.httpSrv = append(d.httpSrv, srv)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			d.log.Error("http-server gestopt", "err", err)
		}
	}()
}

func (d *Daemon) routerLoop() {
	defer d.wg.Done()
	syncT := time.NewTicker(d.deps.SyncInterval)
	defer syncT.Stop()
	hc, hasHealth := d.deps.Router.(proxy.HealthChecker)
	healthT := time.NewTicker(d.deps.HealthInterval)
	defer healthT.Stop()
	if !hasHealth {
		healthT.Stop()
	}
	doSync := func(why string) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := d.routes.Sync(ctx); err != nil {
			d.log.Warn("routes synchroniseren mislukt", "why", why, "err", err)
			d.needSync.Store(true)
			return
		}
		d.needSync.Store(false)
	}
	for {
		select {
		case <-d.stop:
			return
		case <-syncT.C:
			doSync("periodiek")
		case <-healthT.C:
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := hc.Healthy(ctx)
			cancel()
			if err != nil {
				if d.healthy.Swap(2) != 2 {
					d.log.Warn("Caddy ongezond", "err", err)
				}
				d.needSync.Store(true)
				continue
			}
			d.healthy.Store(1)
			if d.needSync.Load() {
				doSync("Caddy weer gezond")
			}
		}
	}
}

// Shutdown stopt de API en achtergrondtaken. Containers blijven draaien.
func (d *Daemon) Shutdown(ctx context.Context) {
	d.closeOnce.Do(func() {
		close(d.stop)
		d.api.CloseAll()
		for _, s := range d.httpSrv {
			_ = s.Shutdown(ctx)
		}
		d.mgr.Close()
		d.wg.Wait()
		if d.cfg.DaemonSocket != "" {
			_ = os.Remove(d.cfg.DaemonSocket)
		}
	})
}

func (d *Daemon) systemInfo(ctx context.Context) api.SystemInfo {
	si := api.SystemInfo{
		Version:       d.deps.Version,
		DiskQuotaMode: DiskQuotaMode,
		CPUCount:      runtime.NumCPU(),
		ServerCount:   d.mgr.Count(),
	}
	si.MemoryTotalBytes, si.MemoryUsedBytes = memInfo()
	var st syscall.Statfs_t
	if err := syscall.Statfs(d.cfg.DataDir, &st); err == nil {
		si.DiskTotalBytes = int64(st.Blocks) * int64(st.Bsize)
		si.DiskFreeBytes = int64(st.Bavail) * int64(st.Bsize)
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if v, err := d.deps.Engine.Version(vctx); err == nil {
		si.DockerVersion = v
	} else {
		si.DockerVersion = "unavailable"
	}
	if _, ok := d.deps.Router.(proxy.HealthChecker); ok {
		h := d.healthy.Load() != 2
		si.CaddyHealthy = &h
	}
	return si
}

func memInfo() (total, used int64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	var avail int64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, _ := strconv.ParseInt(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			total = v * 1024
		case "MemAvailable:":
			avail = v * 1024
		}
	}
	return total, total - avail
}
