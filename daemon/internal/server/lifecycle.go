package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/spec"
)

// ContainerName is de naam van de servercontainer.
func ContainerName(uuid string) string { return "panel-" + uuid }

func installName(uuid string) string { return "panel-" + uuid + "-install" }

const mib = 1024 * 1024

func resources(l spec.Limits) engine.Resources {
	r := engine.Resources{
		NanoCPUs:  int64(l.CPUPct) * 10_000_000,
		Memory:    int64(l.MemoryMB) * mib,
		PidsLimit: int64(l.PidsOrDefault()),
	}
	switch {
	case l.SwapMB < 0:
		r.MemorySwap = -1
	default:
		r.MemorySwap = r.Memory + int64(l.SwapMB)*mib
	}
	return r
}

func (s *Server) containerConfig(sp spec.ServerSpec) engine.ContainerConfig {
	vars := sp.Vars()
	env := map[string]string{"HOME": spec.ContainerHome}
	for k, v := range vars {
		env[k] = v
	}
	var ports []engine.PortBinding
	for _, a := range sp.Allocations {
		for _, proto := range []string{"tcp", "udp"} {
			ports = append(ports, engine.PortBinding{HostIP: a.IP, HostPort: a.Port, ContainerPort: a.Port, Proto: proto})
		}
	}
	return engine.ContainerConfig{
		Name:           ContainerName(sp.UUID),
		Image:          sp.Image,
		Entrypoint:     []string{"/bin/sh", "-c"},
		Cmd:            []string{spec.Expand(sp.Startup, vars)},
		Env:            spec.EnvList(env),
		Labels:         s.m.labels(sp.UUID, RoleServer),
		User:           fmt.Sprintf("%d:%d", s.m.cfg.UID, s.m.cfg.GID),
		WorkingDir:     spec.ContainerHome,
		OpenStdin:      true,
		Mounts:         []engine.Mount{{Source: s.m.volume(sp.UUID), Target: spec.ContainerHome}},
		ReadOnlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,exec,nosuid,nodev,size=256m,mode=1777"},
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		Resources:      resources(sp.Limits),
		Ports:          ports,
		NetworkMode:    s.m.cfg.NetworkMode,
	}
}

func (s *Server) installConfig(sp spec.ServerSpec) engine.ContainerConfig {
	vars := sp.Vars()
	env := map[string]string{"HOME": spec.ContainerHome}
	for k, v := range vars {
		env[k] = v
	}
	r := resources(sp.Limits)
	if r.Memory < 1024*mib {
		r.Memory = 1024 * mib
	}
	r.MemorySwap = r.Memory
	return engine.ContainerConfig{
		Name:        installName(sp.UUID),
		Image:       sp.Install.Image,
		Entrypoint:  []string{"/bin/sh", "-c"},
		Cmd:         []string{sp.Install.Script},
		Env:         spec.EnvList(env),
		Labels:      s.m.labels(sp.UUID, RoleInstall),
		User:        "0:0",
		WorkingDir:  spec.ContainerHome,
		Mounts:      []engine.Mount{{Source: s.m.volume(sp.UUID), Target: spec.ContainerHome}},
		SecurityOpt: []string{"no-new-privileges"},
		Resources:   r,
		NetworkMode: s.m.cfg.NetworkMode,
	}
}

func (s *Server) ensureVolume() error {
	vol := s.m.volume(s.uuid)
	if err := os.MkdirAll(vol, 0o750); err != nil {
		return err
	}
	return os.Lchown(vol, s.m.cfg.UID, s.m.cfg.GID)
}

// chownTree zet de eigenaar van alles onder root op uid:gid (symlinks zelf, niet het doel).
func chownTree(root string, uid, gid int) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		return os.Lchown(p, uid, gid)
	})
}

// ---------- power ----------

// Power voert start/stop/restart/kill uit. De statuscontrole is synchroon; de actie zelf
// loopt op de achtergrond (202 in de API).
func (s *Server) Power(action string) error {
	s.mu.Lock()
	st := s.state
	installing := s.installing
	deleted := s.deleted
	s.mu.Unlock()
	if deleted {
		return ErrNotFound
	}
	switch action {
	case "start", "restart":
		if installing || st == StateInstalling {
			return &StateError{st, "installatie loopt"}
		}
		if st == StateInstallFailed {
			return &StateError{st, "installatie is mislukt; installeer opnieuw"}
		}
	case "stop", "kill":
		if installing || st == StateInstalling {
			return &StateError{st, "installatie loopt"}
		}
	default:
		return fmt.Errorf("onbekende actie %q", action)
	}
	go func() {
		s.opMu.Lock()
		defer s.opMu.Unlock()
		var err error
		switch action {
		case "start":
			err = s.doStart()
		case "stop":
			err = s.doStop(false)
		case "kill":
			err = s.doStop(true)
		case "restart":
			if err = s.doStop(false); err == nil {
				err = s.doStart()
			}
		}
		if err != nil && s.ctx.Err() == nil {
			s.m.log.Warn("power mislukt", "uuid", s.uuid, "action", action, "err", err)
			s.DaemonMessage("error", fmt.Sprintf("%s mislukt: %v", action, err))
		}
	}()
	return nil
}

// doStart start de server (opMu vastgehouden).
func (s *Server) doStart() error {
	s.mu.Lock()
	st := s.state
	sp := s.spec
	running := s.run != nil
	s.mu.Unlock()
	if running || st == StateStarting || st == StateOnline || st == StateStopping {
		return nil
	}
	if st == StateInstalling || st == StateInstallFailed {
		return &StateError{st, "kan niet starten in staat " + st}
	}
	s.setState(StateStarting)
	if err := s.launch(sp); err != nil {
		s.setState(StateOffline)
		return err
	}
	return nil
}

func (s *Server) launch(sp spec.ServerSpec) error {
	ctx := s.ctx
	eng := s.m.eng
	if err := s.ensureVolume(); err != nil {
		return fmt.Errorf("data-map: %w", err)
	}
	if err := spec.ApplyConfigFiles(s.m.volume(sp.UUID), sp.ConfigFiles, sp.Vars(), s.m.cfg.UID, s.m.cfg.GID); err != nil {
		return err
	}
	if err := eng.EnsureImage(ctx, sp.Image, func(l string) { s.DaemonMessage("info", l) }); err != nil {
		return fmt.Errorf("image %s: %w", sp.Image, err)
	}
	if err := eng.Remove(ctx, ContainerName(sp.UUID)); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return fmt.Errorf("oude container verwijderen: %w", err)
	}
	id, err := eng.Create(ctx, s.containerConfig(sp))
	if err != nil {
		return fmt.Errorf("container aanmaken: %w", err)
	}
	att, err := eng.AttachStdin(ctx, id)
	if err != nil {
		_ = eng.Remove(context.Background(), id)
		return fmt.Errorf("stdin koppelen: %w", err)
	}
	s.mu.Lock()
	s.console.Reset()
	s.mu.Unlock()
	if err := eng.Start(ctx, id); err != nil {
		att.Close()
		_ = eng.Remove(context.Background(), id)
		return fmt.Errorf("container starten: %w", err)
	}
	info, err := eng.Inspect(ctx, id)
	if err != nil {
		info.StartedAt = time.Now()
	}
	s.attachRun(id, att, info.StartedAt)
	return nil
}

// attachRun koppelt logs, stats en het exit-signaal van een draaiende container.
func (s *Server) attachRun(id string, att engine.Attachment, startedAt time.Time) *run {
	runCtx, cancel := context.WithCancel(s.ctx)
	r := &run{id: id, att: att, cancel: cancel, done: make(chan struct{})}
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	t := startedAt.UTC()
	s.mu.Lock()
	s.run = r
	s.startedAt = &t
	s.sample = engine.StatsSample{}
	s.mu.Unlock()

	logsDone := make(chan struct{})
	go func() {
		defer close(logsDone)
		rc, err := s.m.eng.Logs(runCtx, id, true)
		if err != nil {
			s.m.log.Warn("logs volgen mislukt", "uuid", s.uuid, "err", err)
			return
		}
		defer rc.Close()
		go func() { <-runCtx.Done(); rc.Close() }()
		readLines(rc, func(l string) { s.onLine(r, l) })
	}()
	go s.pumpStats(runCtx, r)
	go func() {
		defer close(r.done)
		code, err := s.m.eng.Wait(runCtx, id)
		if runCtx.Err() != nil {
			return // daemon stopt of server verwijderd: container met rust laten
		}
		select {
		case <-logsDone:
		case <-time.After(2 * time.Second):
		}
		cancel()
		att.Close()
		s.mu.Lock()
		if s.run == r {
			s.run = nil
			s.startedAt = nil
			s.sample = engine.StatsSample{}
			wasStopping := s.state == StateStopping
			s.setStateLocked(StateOffline)
			if !wasStopping && (code != 0 || err != nil) {
				s.publishLocked(Msg{"event": "daemon_message", "level": "warning", "line": fmt.Sprintf("server gestopt met exitcode %d", code)})
			}
		}
		s.mu.Unlock()
	}()
	return r
}

func (s *Server) pumpStats(ctx context.Context, r *run) {
	for ctx.Err() == nil {
		err := s.m.eng.Stats(ctx, r.id, func(sm engine.StatsSample) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.run != r {
				return
			}
			s.sample = sm
			if time.Since(s.lastStatsPub) >= s.m.cfg.StatsInterval-100*time.Millisecond {
				s.lastStatsPub = time.Now()
				s.publishLocked(statsMsg(s.statsLocked()))
			}
		})
		if err != nil && ctx.Err() == nil {
			s.m.log.Debug("stats-stream", "uuid", s.uuid, "err", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}

// doStop stopt de server (opMu vastgehouden). kill = direct SIGKILL.
func (s *Server) doStop(kill bool) error {
	s.mu.Lock()
	r := s.run
	sp := s.spec
	s.mu.Unlock()
	if r == nil {
		return nil
	}
	eng := s.m.eng
	if !kill {
		s.setState(StateStopping)
		var err error
		switch {
		case sp.Stop.Type == "signal":
			err = eng.Kill(s.ctx, r.id, sp.Stop.Value)
		case sp.Stop.Value == "^C":
			err = eng.Kill(s.ctx, r.id, "SIGINT")
		default:
			err = r.write([]byte(sp.Stop.Value + "\n"))
		}
		if err == nil {
			select {
			case <-r.done:
				return nil
			case <-s.ctx.Done():
				return s.ctx.Err()
			case <-time.After(s.m.cfg.StopTimeout):
				s.DaemonMessage("warning", "server stopt niet op tijd; wordt gekilld")
			}
		}
	} else {
		s.setState(StateStopping)
	}
	if err := eng.Kill(s.ctx, r.id, "SIGKILL"); err != nil && !errors.Is(err, engine.ErrNotFound) {
		s.m.log.Warn("kill mislukt", "uuid", s.uuid, "err", err)
	}
	select {
	case <-r.done:
		return nil
	case <-time.After(30 * time.Second):
		return errors.New("container stopt niet")
	}
}

// ---------- installatie ----------

// Reinstall stopt de server en draait het install-script opnieuw.
func (s *Server) Reinstall() error {
	s.mu.Lock()
	if s.installing || s.state == StateInstalling {
		s.mu.Unlock()
		return &StateError{s.state, "installatie loopt al"}
	}
	s.installing = true
	s.mu.Unlock()
	go func() {
		s.opMu.Lock()
		defer s.opMu.Unlock()
		if err := s.doStop(false); err != nil {
			s.m.log.Warn("stoppen voor herinstallatie mislukt", "uuid", s.uuid, "err", err)
		}
		s.doInstall(false)
	}()
	return nil
}

// doInstall draait het install-script (opMu vastgehouden).
func (s *Server) doInstall(startAfter bool) {
	ctx, cancel := context.WithTimeout(s.ctx, s.m.cfg.InstallTimeout)
	defer cancel()
	s.mu.Lock()
	s.installing = true
	s.installCancel = cancel
	s.installFailed = false
	s.installError = ""
	s.installLog.Reset()
	sp := s.spec
	s.setStateLocked(StateInstalling)
	s.mu.Unlock()
	s.persist()

	err := s.runInstall(ctx, sp)
	if s.m.ctx.Err() != nil {
		return // daemon stopt; bij de volgende start wordt dit install_failed
	}
	if cerr := chownTree(s.m.volume(s.uuid), s.m.cfg.UID, s.m.cfg.GID); cerr != nil && err == nil {
		err = fmt.Errorf("chown: %w", cerr)
	}
	s.mu.Lock()
	s.installing = false
	s.installCancel = nil
	deleted := s.deleted
	if err != nil {
		s.installFailed = true
		s.installError = err.Error()
		s.setStateLocked(StateInstallFailed)
	} else {
		now := time.Now().UTC()
		s.installedAt = &now
		s.setStateLocked(StateOffline)
	}
	s.mu.Unlock()
	if deleted {
		return
	}
	s.persist()
	if err != nil {
		s.installLine("installatie mislukt: " + err.Error())
		s.m.rep.ReportInstall(s.uuid, false, err.Error())
		return
	}
	s.installLine("installatie klaar")
	s.m.rep.ReportInstall(s.uuid, true, "")
	go s.measureDisk()
	if startAfter {
		if err := s.doStart(); err != nil {
			s.DaemonMessage("error", "starten na installatie mislukt: "+err.Error())
		}
	}
}

func (s *Server) runInstall(ctx context.Context, sp spec.ServerSpec) error {
	eng := s.m.eng
	if err := s.ensureVolume(); err != nil {
		return fmt.Errorf("data-map: %w", err)
	}
	if err := eng.EnsureImage(ctx, sp.Install.Image, s.installLine); err != nil {
		return fmt.Errorf("image %s: %w", sp.Install.Image, err)
	}
	name := installName(sp.UUID)
	if err := eng.Remove(ctx, name); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return err
	}
	id, err := eng.Create(ctx, s.installConfig(sp))
	if err != nil {
		return fmt.Errorf("install-container aanmaken: %w", err)
	}
	defer func() { _ = eng.Remove(context.Background(), id) }()
	if err := eng.Start(ctx, id); err != nil {
		return fmt.Errorf("install-container starten: %w", err)
	}
	logsDone := make(chan struct{})
	go func() {
		defer close(logsDone)
		rc, err := eng.Logs(ctx, id, true)
		if err != nil {
			return
		}
		defer rc.Close()
		readLines(rc, s.installLine)
	}()
	code, err := eng.Wait(ctx, id)
	if ctx.Err() != nil {
		_ = eng.Kill(context.Background(), id, "SIGKILL")
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errors.New("installatie duurde te lang")
		}
		return errors.New("installatie afgebroken")
	}
	select {
	case <-logsDone:
	case <-time.After(5 * time.Second):
	}
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("install-script eindigde met exitcode %d", code)
	}
	return nil
}

// ---------- bijwerken en verwijderen ----------

// Update vervangt de spec. Limieten gaan direct in; de rest bij de volgende start.
func (s *Server) Update(sp spec.ServerSpec) error {
	s.mu.Lock()
	s.spec = sp
	s.ready = compileReady(sp.ReadyPattern)
	r := s.run
	err := s.persistLocked()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if r != nil {
		if err := s.m.eng.Update(s.ctx, r.id, resources(sp.Limits)); err != nil {
			s.m.log.Warn("limieten bijwerken mislukt", "uuid", s.uuid, "err", err)
		}
	}
	return nil
}

// destroy verwijdert containers, data en staat. Websockets sluiten met 4004.
func (s *Server) destroy() error {
	s.mu.Lock()
	s.deleted = true
	if s.installCancel != nil {
		s.installCancel()
	}
	s.mu.Unlock()

	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	r := s.run
	s.run = nil
	for sub := range s.subs {
		sub.Close(4004, "server verwijderd")
	}
	s.subs = map[*Sub]struct{}{}
	s.mu.Unlock()
	if r != nil {
		r.cancel()
		r.att.Close()
	}
	s.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for _, n := range []string{ContainerName(s.uuid), installName(s.uuid)} {
		if err := s.m.eng.Remove(ctx, n); err != nil && !errors.Is(err, engine.ErrNotFound) {
			return fmt.Errorf("container %s verwijderen: %w", n, err)
		}
	}
	if err := os.RemoveAll(s.m.volume(s.uuid)); err != nil {
		return fmt.Errorf("data verwijderen: %w", err)
	}
	if err := os.Remove(s.m.statePath(s.uuid)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// ---------- disk ----------

// DirSize telt de grootte van alle bestanden onder root (zonder symlinks te volgen).
func DirSize(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total, err
}

func (s *Server) measureDisk() {
	n, err := DirSize(s.m.volume(s.uuid))
	if err != nil {
		s.m.log.Debug("disk meten", "uuid", s.uuid, "err", err)
	}
	s.mu.Lock()
	s.diskBytes = n
	s.mu.Unlock()
}

// diskLoop meet elke DiskInterval, met een vaste verschuiving per server zodat niet alle
// metingen tegelijk vallen.
func (s *Server) diskLoop(offset time.Duration) {
	select {
	case <-s.ctx.Done():
		return
	case <-time.After(offset):
	}
	t := time.NewTicker(s.m.cfg.DiskInterval)
	defer t.Stop()
	for {
		s.measureDisk()
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
		}
	}
}
