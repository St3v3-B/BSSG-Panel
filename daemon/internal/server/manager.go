package server

import (
	"context"
	"errors"
	"hash/fnv"
	"log/slog"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/spec"
	"panel/daemon/internal/store"
)

// Labels.
const (
	LabelManaged  = "panel.managed"
	LabelInstance = "panel.instance"
	LabelUUID     = "panel.server_uuid"
	LabelRole     = "panel.role"

	// Waarden van panel.role. RoleInfra (de compose-stack) raakt de daemon nooit aan.
	RoleServer  = "server"
	RoleInstall = "install"
	RoleInfra   = "infra"
)

// Reporter meldt dingen aan het panel (best effort, asynchroon).
type Reporter interface {
	ReportStatus(uuid, state string)
	ReportInstall(uuid string, ok bool, errMsg string)
}

// Config van de manager.
type Config struct {
	DataDir        string
	Instance       string
	ExtraLabels    map[string]string
	UID, GID       int
	NetworkMode    string
	StopTimeout    time.Duration
	InstallTimeout time.Duration
	DiskInterval   time.Duration
	StatsInterval  time.Duration
	BacklogLines   int
	// MariaDB is de containernaam van de gedeelde MariaDB (standaard panel-mariadb;
	// tests gebruiken een eigen naam).
	MariaDB string
}

func (c *Config) defaults() {
	if c.UID == 0 && c.GID == 0 {
		c.UID, c.GID = 1000, 1000
	}
	if c.NetworkMode == "" {
		c.NetworkMode = "bridge"
	}
	if c.StopTimeout == 0 {
		c.StopTimeout = 30 * time.Second
	}
	if c.InstallTimeout == 0 {
		c.InstallTimeout = 30 * time.Minute
	}
	if c.DiskInterval == 0 {
		c.DiskInterval = time.Minute
	}
	if c.StatsInterval == 0 {
		c.StatsInterval = 2 * time.Second
	}
	if c.BacklogLines == 0 {
		c.BacklogLines = 500
	}
	if c.MariaDB == "" {
		c.MariaDB = MariaDBContainer
	}
	if c.Instance == "" {
		c.Instance = "main"
	}
}

// Manager beheert alle servers.
type Manager struct {
	cfg Config
	eng engine.Engine
	rep Reporter
	log *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.RWMutex
	servers map[string]*Server

	onState func(uuid, state string)
}

// OnState registreert een functie die bij elke statuswijziging wordt aangeroepen (onder
// de serverlock: hij moet direct terugkeren). Aanroepen vóór Recover.
func (m *Manager) OnState(fn func(uuid, state string)) { m.onState = fn }

// NewManager maakt een manager. Roep daarna Recover aan.
func NewManager(cfg Config, eng engine.Engine, rep Reporter, log *slog.Logger) *Manager {
	cfg.defaults()
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{cfg: cfg, eng: eng, rep: rep, log: log, ctx: ctx, cancel: cancel, servers: map[string]*Server{}}
}

// Close stopt alle achtergrondtaken. Containers blijven draaien.
func (m *Manager) Close() { m.cancel() }

func (m *Manager) volume(uuid string) string {
	return filepath.Join(m.cfg.DataDir, "volumes", uuid)
}

func (m *Manager) statePath(uuid string) string {
	return filepath.Join(m.cfg.DataDir, "state", "servers", uuid+".json")
}

func (m *Manager) writeState(uuid string, p persisted) error {
	return store.WriteJSON(m.statePath(uuid), p)
}

// BaseLabels zijn de labels die alles van deze daemon krijgt.
func (m *Manager) BaseLabels() map[string]string {
	l := map[string]string{}
	for k, v := range m.cfg.ExtraLabels {
		l[k] = v
	}
	l[LabelManaged] = "true"
	l[LabelInstance] = m.cfg.Instance
	return l
}

func (m *Manager) labels(uuid, role string) map[string]string {
	l := m.BaseLabels()
	l[LabelUUID] = uuid
	l[LabelRole] = role
	return l
}

func compileReady(p string) *regexp.Regexp {
	re, err := regexp.Compile(p)
	if err != nil {
		return nil
	}
	return re
}

func (m *Manager) newServer(sp spec.ServerSpec) *Server {
	ctx, cancel := context.WithCancel(m.ctx)
	return &Server{
		m: m, uuid: sp.UUID, ctx: ctx, cancel: cancel,
		spec: sp, ready: compileReady(sp.ReadyPattern),
		state:      StateOffline,
		console:    NewRing(m.cfg.BacklogLines),
		installLog: NewRing(m.cfg.BacklogLines),
		subs:       map[*Sub]struct{}{},
	}
}

func (m *Manager) diskOffset(uuid string) time.Duration {
	h := fnv.New32a()
	_, _ = h.Write([]byte(uuid))
	return time.Duration(h.Sum32()%1000) * m.cfg.DiskInterval / 1000
}

func (m *Manager) register(s *Server) {
	m.servers[s.uuid] = s
	go s.diskLoop(m.diskOffset(s.uuid))
}

// Get zoekt een server op uuid.
func (m *Manager) Get(uuid string) (*Server, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.servers[strings.ToLower(uuid)]
	return s, ok
}

// List geeft alle servers, gesorteerd op uuid.
func (m *Manager) List() []*Server {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Server, 0, len(m.servers))
	for _, s := range m.servers {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].uuid < out[j].uuid })
	return out
}

// Count is het aantal servers.
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.servers)
}

// Create maakt een server aan en start de installatie. created=false betekent: bestond al
// met dezelfde spec (idempotent).
func (m *Manager) Create(sp spec.ServerSpec) (*Server, bool, error) {
	sp.UUID = strings.ToLower(sp.UUID)
	m.mu.Lock()
	if s, ok := m.servers[sp.UUID]; ok {
		m.mu.Unlock()
		if s.Spec().SameAs(sp) {
			return s, false, nil
		}
		return s, false, ErrExists
	}
	s := m.newServer(sp)
	if err := s.ensureVolume(); err != nil {
		m.mu.Unlock()
		s.cancel()
		return nil, false, err
	}
	if sp.SkipInstall {
		now := time.Now().UTC()
		s.installedAt = &now
	} else {
		s.state = StateInstalling
		s.installing = true
	}
	if err := s.persistLocked(); err != nil {
		m.mu.Unlock()
		s.cancel()
		return nil, false, err
	}
	m.register(s)
	m.mu.Unlock()

	if sp.Type == "web" {
		ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
		if err := m.ensureSiteNetwork(ctx, s.uuid); err != nil {
			m.log.Warn("site-netwerk", "uuid", s.uuid, "err", err)
		}
		cancel()
	}
	if sp.SkipInstall {
		m.rep.ReportInstall(s.uuid, true, "")
		if sp.StartOnInstall {
			_ = s.Power("start")
		}
	} else {
		m.rep.ReportStatus(s.uuid, StateInstalling)
		go func() {
			s.opMu.Lock()
			defer s.opMu.Unlock()
			s.doInstall(sp.StartOnInstall)
		}()
	}
	return s, true, nil
}

// Delete verwijdert een server volledig.
func (m *Manager) Delete(uuid string) error {
	s, ok := m.Get(uuid)
	if !ok {
		return ErrNotFound
	}
	if err := s.destroy(); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.servers, s.uuid)
	m.mu.Unlock()
	return nil
}

// Recover laadt de staat van schijf en koppelt draaiende containers weer aan.
// Containers worden nooit gestopt; alleen achtergebleven install-containers gaan weg.
func (m *Manager) Recover(ctx context.Context) error {
	files, err := filepath.Glob(filepath.Join(m.cfg.DataDir, "state", "servers", "*.json"))
	if err != nil {
		return err
	}
	var interrupted []*Server
	m.mu.Lock()
	for _, f := range files {
		var p persisted
		if err := store.ReadJSON(f, &p); err != nil {
			m.log.Error("staat lezen mislukt", "file", f, "err", err)
			continue
		}
		if !spec.ValidUUID(p.Spec.UUID) {
			continue
		}
		s := m.newServer(p.Spec)
		s.installedAt = p.InstalledAt
		s.installFailed = p.InstallFailed
		s.installError = p.InstallError
		switch {
		case p.InstallFailed:
			s.state = StateInstallFailed
		case p.InstalledAt == nil:
			// De daemon stopte tijdens de installatie.
			s.state = StateInstallFailed
			s.installFailed = true
			s.installError = "daemon herstart tijdens de installatie"
			_ = s.persistLocked()
			interrupted = append(interrupted, s)
		}
		m.register(s)
	}
	m.mu.Unlock()

	list, err := m.eng.List(ctx, map[string]string{LabelManaged: "true", LabelInstance: m.cfg.Instance})
	if err != nil {
		return err
	}
	for _, c := range list {
		role := c.Labels[LabelRole]
		if role != RoleServer && role != RoleInstall {
			continue // o.a. panel.role=infra: nooit aanraken
		}
		uuid := c.Labels[LabelUUID]
		s, ok := m.Get(uuid)
		if !ok || uuid == "" {
			m.log.Warn("container zonder bekende server, niet aangeraakt", "container", c.Name)
			continue
		}
		if role == RoleInstall {
			if c.Name != installName(uuid) {
				continue
			}
			if err := m.eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, engine.ErrNotFound) {
				m.log.Warn("install-container opruimen mislukt", "container", c.Name, "err", err)
			}
			continue
		}
		if c.Name != ContainerName(uuid) || !c.Running {
			continue
		}
		info, err := m.eng.Inspect(ctx, c.ID)
		if err != nil || !info.Running {
			continue
		}
		att, err := m.eng.AttachStdin(ctx, c.ID)
		if err != nil {
			m.log.Error("stdin koppelen mislukt", "uuid", uuid, "err", err)
			continue
		}
		s.mu.Lock()
		s.state = StateStarting // het ready-patroon in de log zet hem op online
		s.mu.Unlock()
		s.attachRun(c.ID, att, info.StartedAt)
		m.log.Info("container weer gekoppeld", "uuid", uuid)
	}
	for _, s := range interrupted {
		m.rep.ReportInstall(s.uuid, false, s.installError)
	}
	// Na het teruglezen van de logs de actuele status aan het panel melden.
	go func() {
		select {
		case <-m.ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
		for _, s := range m.List() {
			m.rep.ReportStatus(s.uuid, s.State())
		}
	}()
	return nil
}
