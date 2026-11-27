// Package daemon zet alle onderdelen in elkaar: config, Docker, manager, API, Router.
package daemon

import (
	"bufio"
	"context"
	"crypto/tls"
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
	"panel/daemon/internal/backup"
	"panel/daemon/internal/config"
	"panel/daemon/internal/dbadmin"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/selfupdate"
	"panel/daemon/internal/server"
	"panel/daemon/internal/sftpd"
	"panel/daemon/internal/tlscert"
	"panel/daemon/internal/upgrade"
	"panel/daemon/proxy"
)

// Deps zijn de onderdelen die tests kunnen vervangen.
type Deps struct {
	Engine  engine.Engine
	Router  proxy.Router
	Log     *slog.Logger
	Version string
	// Commit: git-commit waaruit gebouwd (-X main.commit), voor /api/system.
	Commit string
	// Server-opties (tests zetten korte tijden).
	Server server.Config
	// Image stelt de image-updater af (Interval komt anders uit IMAGE_CHECK_INTERVAL).
	Image server.ImageConfig
	// Panel, als gezet, vervangt de standaard panel-client.
	Panel *panel.Client
	// WSAuthTimeout: tijd voor het eerste auth-bericht (standaard 10 s).
	WSAuthTimeout time.Duration
	// SyncInterval voor Router.Sync (standaard 5 min) en HealthInterval (15 s).
	SyncInterval, HealthInterval time.Duration
	// SFTPAddr vervangt ":$SFTP_PORT" (tests: 127.0.0.1:0). Leeg en SFTP_PORT 0 = geen SFTP.
	SFTPAddr string
	// FreeInterval: hoe vaak de vrije schijfruimte gecontroleerd wordt (standaard 15 s).
	FreeInterval time.Duration
	// Statfs vervangt server.FreeSpace (tests).
	Statfs func(string) (int64, int64, error)
	// SFTPFailDelay na een mislukte SFTP-login (standaard 1 s).
	SFTPFailDelay time.Duration
	// Updater vervangt de standaard (PANEL_URL + eigen binary); Restart vervangt SIGTERM naar het eigen proces.
	Updater *selfupdate.Updater
	Restart func()
	// HelloInterval: hoe vaak de hello herhaald wordt (standaard 5 min); HelloRetry: wachttijd na een mislukte hello (30 s).
	HelloInterval, HelloRetry time.Duration
	// DBWatchInterval: hoe vaak de MariaDB-beschikbaarheid gecontroleerd wordt (standaard 20 s).
	DBWatchInterval time.Duration
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
	backup *backup.Service
	dbadm  *dbadmin.Admin
	sftp   *sftpd.Server

	healthy   atomic.Int32 // 0 onbekend, 1 gezond, 2 ongezond
	needSync  atomic.Bool
	httpSrv   []*http.Server
	tcpAddr   string
	stop      chan struct{}
	wg        sync.WaitGroup
	closeOnce sync.Once
}

// DiskQuotaMode: harde XFS-quota zijn not implemented yet (alleen gedetecteerd en gelogd).
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
	if sc.MariaDB == "" {
		sc.MariaDB = cfg.MariaDBContainer
	}
	if !sc.NetworkPool.IsValid() {
		sc.NetworkPool = cfg.NetworkPool
	}
	d.mgr = server.NewManager(sc, deps.Engine, d.panel, deps.Log)
	ic := deps.Image
	if ic.Interval == 0 {
		ic.Interval = cfg.ImageCheckInterval
	}
	d.mgr.EnableImageUpdates(d.panel, ic)
	routes, err := api.NewRoutes(filepath.Join(cfg.DataDir, "state", "routes.json"), deps.Router, d.mgr, deps.Log)
	if err != nil {
		return nil, fmt.Errorf("routes.json: %w", err)
	}
	d.routes = routes
	d.mgr.OnState(func(uuid, _ string) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			d.routes.Refresh(ctx, uuid)
		}()
	})
	verifier := auth.NewVerifier(d.panel.JWKS, cfg.NodeDomain)
	d.backup = &backup.Service{Mgr: d.mgr, Rep: d.panel, Log: deps.Log}
	upd := deps.Updater
	if upd == nil {
		upd = &selfupdate.Updater{PanelURL: cfg.PanelURL}
	}
	restart := deps.Restart
	if restart == nil {
		restart = func() { _ = syscall.Kill(os.Getpid(), syscall.SIGTERM) }
	}
	d.api = api.New(api.Options{NodeToken: cfg.NodeToken, AllowedOrigins: cfg.AllowedOrigins(), AuthTimeout: deps.WSAuthTimeout, Update: upd.Run, Restart: restart}, d.mgr, routes, verifier, d.systemInfo, deps.Log)
	d.api.SetBackups(d.backup)
	if cfg.PanelRepoDir != "" {
		d.api.SetUpgrade(&upgrade.Service{RepoDir: cfg.PanelRepoDir, UpgradeDir: filepath.Join(cfg.DataDir, "upgrade")})
	}
	if cfg.MariaDBRootPassword != "" {
		d.dbadm = &dbadmin.Admin{Eng: deps.Engine, Container: cfg.MariaDBContainer, RootPassword: cfg.MariaDBRootPassword}
		d.api.SetDBAdmin(d.dbadm, cfg.MariaDBContainer)
	}
	return d, nil
}

func (d *Daemon) sftpAddr() string {
	if d.deps.SFTPAddr != "" {
		return d.deps.SFTPAddr
	}
	if d.cfg.SFTPPort == 0 {
		return ""
	}
	return ":" + strconv.Itoa(d.cfg.SFTPPort)
}

// SFTPAddr is het adres van de SFTP-server ("" als die uit staat).
func (d *Daemon) SFTPAddr() string {
	if d.sftp == nil {
		return ""
	}
	return d.sftp.Addr()
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
	d.mgr.ReconcileNetworks(ctx)
	d.mgr.StartImageUpdates()
	if err := d.routes.Sync(ctx); err != nil {
		d.log.Warn("syncing routes failed", "err", err)
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
	if d.cfg.TLSPort > 0 {
		m := &tlscert.Manager{
			Domain: d.cfg.NodeDomain, Email: d.cfg.ACMEEmail, Directory: d.cfg.ACMEDirectory,
			Dir: filepath.Join(d.cfg.DataDir, "state", "tls"), DNS: tlscert.PanelDNS{Do: d.panel.ACMEDNS}, Log: d.log,
		}
		m.Load()
		tln, err := tls.Listen("tcp", net.JoinHostPort("", strconv.Itoa(d.cfg.TLSPort)), &tls.Config{GetCertificate: m.GetCertificate, MinVersion: tls.VersionTLS12})
		if err != nil {
			return fmt.Errorf("tls %d: %w", d.cfg.TLSPort, err)
		}
		d.serve(tln, h)
		d.wg.Add(1)
		go func() {
			defer d.wg.Done()
			ctx, cancel := context.WithCancel(context.Background())
			go func() { <-d.stop; cancel() }()
			m.Run(ctx)
		}()
		d.log.Info("https listener for the node domain", "port", d.cfg.TLSPort)
	}
	d.log.Info("daemon luistert", "tcp", d.tcpAddr, "socket", d.cfg.DaemonSocket, "version", d.deps.Version, "servers", d.mgr.Count())

	if addr := d.sftpAddr(); addr != "" {
		key, err := sftpd.LoadHostKey(filepath.Join(d.cfg.DataDir, "state", "sftp_host_ed25519_key"))
		if err != nil {
			return fmt.Errorf("sftp-hostsleutel: %w", err)
		}
		d.sftp = &sftpd.Server{Auth: d.panel, Servers: d.mgr, Log: d.log, FailDelay: d.deps.SFTPFailDelay}
		if err := d.sftp.Start(addr, key); err != nil {
			return fmt.Errorf("sftp: %w", err)
		}
		d.log.Info("sftp luistert", "addr", d.sftp.Addr())
	}

	if server.DetectXFSPrjquota(filepath.Join(d.cfg.DataDir, "volumes")) {
		d.log.Warn("XFS met prjquota gedetecteerd; harde quota zijn not implemented yet, de daemon gebruikt de softe limiet")
	}
	fi := d.deps.FreeInterval
	if fi == 0 {
		fi = 15 * time.Second
	}
	go d.mgr.FreeWatch(fi, d.deps.Statfs)

	hasDB := d.hasMariaDB()
	d.wg.Add(1)
	go d.helloLoop()
	if d.dbadm != nil {
		d.wg.Add(1)
		go d.mariaDBWatch(hasDB)
	}
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
			return nil, errors.New("already exists and is not a socket")
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
			d.log.Error("http server stopped", "err", err)
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
			d.log.Warn("syncing routes failed", "why", why, "err", err)
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
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			d.mgr.ReconcileNetworks(ctx)
			cancel()
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
		if d.sftp != nil {
			d.sftp.Close()
		}
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
		Commit:        d.deps.Commit,
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

// hasMariaDB: de lokale MariaDB bestaat, het rootwachtwoord is bekend en hij antwoordt.
func (d *Daemon) hasMariaDB() bool {
	if d.dbadm == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return d.dbadm.Status(ctx) == nil
}

// mariaDBWatch meldt zich opnieuw bij het panel als de MariaDB (de)bereikbaar wordt, bv. omdat compose
// hem pas na de daemon startte.
func (d *Daemon) mariaDBWatch(announced bool) {
	defer d.wg.Done()
	iv := d.deps.DBWatchInterval
	if iv == 0 {
		iv = 20 * time.Second
	}
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		select {
		case <-d.stop:
			return
		case <-t.C:
		}
		if now := d.hasMariaDB(); now != announced {
			announced = now
			d.log.Info("mariadb availability changed", "available", now)
			d.panel.Hello(d.deps.Version, DiskQuotaMode, now)
		}
	}
}

// helloLoop meldt de daemon bij het panel: meteen bij de start en daarna periodiek (idempotent aan de panelkant).
// Mislukt een hello (panel nog niet gestart, bv. omdat install.sh de daemon eerder herstart dan de stack, of een
// storing), dan volgt na HelloRetry een nieuwe poging, dus kort nadat het panel weer antwoordt.
func (d *Daemon) helloLoop() {
	defer d.wg.Done()
	every, retry := d.deps.HelloInterval, d.deps.HelloRetry
	if every == 0 {
		every = 5 * time.Minute
	}
	if retry == 0 {
		retry = 30 * time.Second
	}
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := d.panel.HelloNow(ctx, d.deps.Version, DiskQuotaMode, d.hasMariaDB())
		cancel()
		wait := every
		if err != nil {
			d.log.Warn("hello to panel failed; retrying", "err", err)
			wait = retry
		}
		select {
		case <-d.stop:
			return
		case <-time.After(wait):
		}
	}
}
