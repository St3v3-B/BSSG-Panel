package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/spec"
)

// RoleShell is panel.role van een tools-container voor de webterminal of SSH-shell.
const RoleShell = "shell"

// Standaardlimieten voor shells (Config.ShellsPerServer / ShellsTotal).
const (
	DefaultShellsPerServer = 3
	DefaultShellsTotal     = 20
)

// ErrTooManyShells: de limiet per server of per node is bereikt.
var ErrTooManyShells = errors.New("too many open shells")

// ErrNoTTY: de engine ondersteunt geen interactieve containers.
var ErrNoTTY = errors.New("engine has no tty support")

// shellScript start bash als die er is, anders sh (alpine/busybox).
const shellScript = `if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`

// ShellName is de containernaam van een shell (eigen suffix per sessie).
func ShellName(uuid, suffix string) string { return "panel-" + uuid + "-shell-" + suffix }

// Shell is een open interactieve shell in een kortlevende tools-container.
type Shell struct {
	m      *Manager
	uuid   string
	name   string
	id     string
	conn   io.ReadWriteCloser
	tty    engine.TTY
	done   chan struct{}
	exit   int
	closed sync.Once
}

// UUID van de server.
func (sh *Shell) UUID() string { return sh.uuid }

// Name van de container.
func (sh *Shell) Name() string { return sh.name }

// Read leest uitvoer van de pty.
func (sh *Shell) Read(p []byte) (int, error) { return sh.conn.Read(p) }

// Write stuurt invoer naar de pty.
func (sh *Shell) Write(p []byte) (int, error) { return sh.conn.Write(p) }

// Resize zet de venstergrootte (begrensd tot 500×200).
func (sh *Shell) Resize(cols, rows int) error {
	cols, rows = clampSize(cols, rows)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return sh.tty.ResizeTTY(ctx, sh.id, uint(rows), uint(cols))
}

// Done is gesloten zodra de shell gestopt is; ExitCode is daarna geldig.
func (sh *Shell) Done() <-chan struct{} { return sh.done }

// ExitCode van de shell (na Done).
func (sh *Shell) ExitCode() int { return sh.exit }

// Close stopt de shell en verwijdert de container (idempotent).
func (sh *Shell) Close() {
	sh.closed.Do(func() {
		_ = sh.conn.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := sh.m.eng.Remove(ctx, sh.id); err != nil && !errors.Is(err, engine.ErrNotFound) {
			sh.m.log.Warn("shell container removal failed", "container", sh.name, "err", err)
		}
		sh.m.shellMu.Lock()
		delete(sh.m.shells, sh)
		sh.m.shellMu.Unlock()
	})
}

func clampSize(cols, rows int) (int, int) {
	return min(max(cols, 1), 500), min(max(rows, 1), 200)
}

func (m *Manager) shellConfig(sp spec.ServerSpec, name string) engine.ContainerConfig {
	vars := sp.Vars()
	env := map[string]string{"HOME": spec.ContainerHome, "TERM": "xterm-256color", "LANG": "C.UTF-8", "TZ": "Europe/Amsterdam"}
	for k, v := range vars {
		env[k] = v
	}
	img := m.cfg.TerminalImage
	if img == "" {
		img = sp.Image
	}
	r := resources(sp.Limits)
	if r.PidsLimit <= 0 || r.PidsLimit > 256 {
		r.PidsLimit = 256
	}
	return engine.ContainerConfig{
		Name:           name,
		Image:          img,
		Entrypoint:     []string{"/bin/sh", "-c"},
		Cmd:            []string{shellScript},
		Env:            spec.EnvList(env),
		Labels:         m.labels(sp.UUID, RoleShell),
		User:           fmt.Sprintf("%d:%d", m.cfg.UID, m.cfg.GID),
		WorkingDir:     spec.ContainerHome,
		OpenStdin:      true,
		Tty:            true,
		Mounts:         []engine.Mount{{Source: m.volume(sp.UUID), Target: spec.ContainerHome}},
		ReadOnlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,exec,nosuid,nodev,size=256m,mode=1777"},
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		Resources:      r,
		NetworkMode:    SiteNetwork(sp.UUID),
		Init:           true,
	}
}

// OpenShell start een tools-container voor de server (hoeft niet te draaien) en koppelt de pty.
// Bij een fout blijft er geen container achter.
func (m *Manager) OpenShell(ctx context.Context, uuid string, cols, rows int) (*Shell, error) {
	s, ok := m.Get(uuid)
	if !ok {
		return nil, ErrNotFound
	}
	tty, ok := m.eng.(engine.TTY)
	if !ok {
		return nil, ErrNoTTY
	}
	sp := s.Spec()
	if st := s.State(); st == StateInstalling {
		return nil, &StateError{Msg: "server is installing"}
	}
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	sh := &Shell{m: m, uuid: uuid, name: ShellName(uuid, hex.EncodeToString(suffix[:])), tty: tty, done: make(chan struct{})}

	// Plaats reserveren vóór het aanmaken (limieten gelden ook voor shells die nog starten).
	m.shellMu.Lock()
	per := 0
	for o := range m.shells {
		if o.uuid == uuid {
			per++
		}
	}
	if per >= m.cfg.ShellsPerServer || len(m.shells) >= m.cfg.ShellsTotal {
		m.shellMu.Unlock()
		return nil, ErrTooManyShells
	}
	m.shells[sh] = struct{}{}
	m.shellMu.Unlock()
	release := func() {
		m.shellMu.Lock()
		delete(m.shells, sh)
		m.shellMu.Unlock()
	}

	cfg := m.shellConfig(sp, sh.name)
	if err := s.ensureVolume(); err != nil {
		release()
		return nil, err
	}
	if err := m.eng.EnsureImage(ctx, cfg.Image, nil); err != nil {
		release()
		return nil, fmt.Errorf("image %s: %w", cfg.Image, err)
	}
	var netErr error
	if sp.Type == "web" {
		netErr = m.ensureSiteNetwork(ctx, uuid)
	} else {
		netErr = m.ensureServerNetwork(ctx, uuid)
	}
	if netErr != nil {
		release()
		return nil, netErr
	}
	id, err := m.eng.Create(ctx, cfg)
	if err != nil {
		release()
		return nil, err
	}
	sh.id = id
	fail := func(err error) (*Shell, error) {
		rctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = m.eng.Remove(rctx, id)
		release()
		return nil, err
	}
	conn, err := tty.AttachTTY(ctx, id)
	if err != nil {
		return fail(err)
	}
	sh.conn = conn
	if err := m.eng.Start(ctx, id); err != nil {
		conn.Close()
		return fail(err)
	}
	if cols > 0 && rows > 0 {
		_ = sh.Resize(cols, rows)
	}
	go func() {
		code, err := m.eng.Wait(context.Background(), id)
		if err != nil {
			code = -1
		}
		sh.exit = code
		close(sh.done)
	}()
	m.log.Info("shell geopend", "uuid", uuid, "container", sh.name)
	return sh, nil
}

// Shells is het aantal open shells (voor tests en /api/system).
func (m *Manager) Shells(uuid string) int {
	m.shellMu.Lock()
	defer m.shellMu.Unlock()
	if uuid == "" {
		return len(m.shells)
	}
	n := 0
	for sh := range m.shells {
		if sh.uuid == uuid {
			n++
		}
	}
	return n
}

// closeShells sluit alle shells van een server ("" = alle).
func (m *Manager) closeShells(uuid string) {
	m.shellMu.Lock()
	var list []*Shell
	for sh := range m.shells {
		if uuid == "" || sh.uuid == uuid {
			list = append(list, sh)
		}
	}
	m.shellMu.Unlock()
	for _, sh := range list {
		if sh.conn != nil {
			sh.Close()
		}
	}
}

// removeOrphanShells verwijdert achtergebleven shell-containers (na een crash of herstart van de daemon).
// Alleen containers met onze labels én panel.role=shell.
func (m *Manager) removeOrphanShells(ctx context.Context) {
	l := m.BaseLabels()
	l[LabelRole] = RoleShell
	list, err := m.eng.List(ctx, l)
	if err != nil {
		m.log.Warn("listing shell containers failed", "err", err)
		return
	}
	m.shellMu.Lock()
	open := map[string]bool{}
	for sh := range m.shells {
		open[sh.name] = true
	}
	m.shellMu.Unlock()
	for _, c := range list {
		if c.Labels[LabelManaged] != "true" || c.Labels[LabelInstance] != m.cfg.Instance || c.Labels[LabelRole] != RoleShell || open[c.Name] {
			continue
		}
		if err := m.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, engine.ErrNotFound) {
			m.log.Warn("removing orphan shell failed", "container", c.Name, "err", err)
		}
	}
}
