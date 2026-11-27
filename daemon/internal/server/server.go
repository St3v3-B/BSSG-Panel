// Package server beheert de servers op deze node: containers, installatie, power,
// console, stats en herstel na een herstart van de daemon.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/mcproto"
	"panel/daemon/internal/spec"
)

// Toestanden (ServerState.state in openapi.yaml).
const (
	StateInstalling    = "installing"
	StateInstallFailed = "install_failed"
	StateOffline       = "offline"
	StateStarting      = "starting"
	StateOnline        = "online"
	StateStopping      = "stopping"
	StateDiskExceeded  = "disk_exceeded"
)

// Fouten die de API vertaalt naar statuscodes.
var (
	ErrNotFound     = errors.New("server not found")
	ErrExists       = errors.New("server already exists with a different spec")
	ErrInvalidState = errors.New("not possible in this state")
	ErrNotRunning   = errors.New("server is not running")
)

// StateError draagt een toelichting bij ErrInvalidState.
type StateError struct{ State, Msg string }

func (e *StateError) Error() string { return e.Msg }
func (e *StateError) Unwrap() error { return ErrInvalidState }

// View is ServerState uit openapi.yaml.
type View struct {
	UUID         string     `json:"uuid"`
	State        string     `json:"state"`
	DiskBytes    int64      `json:"disk_bytes"`
	DiskExceeded bool       `json:"disk_exceeded"`
	StartedAt    *time.Time `json:"started_at"`
	InstalledAt  *time.Time `json:"installed_at"`
}

// Stats is het Stats-schema uit openapi.yaml.
type Stats struct {
	CPUPct           float64 `json:"cpu_pct"`
	MemoryBytes      int64   `json:"memory_bytes"`
	MemoryLimitBytes int64   `json:"memory_limit_bytes"`
	NetworkRxBytes   int64   `json:"network_rx_bytes"`
	NetworkTxBytes   int64   `json:"network_tx_bytes"`
	DiskBytes        int64   `json:"disk_bytes"`
	DiskLimitBytes   int64   `json:"disk_limit_bytes"`
	UptimeMs         int64   `json:"uptime_ms"`
}

// persisted is wat in $DATA_DIR/state/servers/<uuid>.json staat.
type persisted struct {
	Spec          spec.ServerSpec `json:"spec"`
	InstalledAt   *time.Time      `json:"installed_at"`
	InstallFailed bool            `json:"install_failed,omitempty"`
	InstallError  string          `json:"install_error,omitempty"`
	Sleeping      bool            `json:"sleeping,omitempty"`
}

// run is één draaiende container.
type run struct {
	id     string
	att    engine.Attachment
	wmu    sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

func (r *run) write(p []byte) error {
	r.wmu.Lock()
	defer r.wmu.Unlock()
	_, err := r.att.Write(p)
	return err
}

// Server is één server op deze node.
type Server struct {
	m    *Manager
	uuid string

	ctx    context.Context // tot de server verwijderd wordt
	cancel context.CancelFunc

	opMu sync.Mutex // serialiseert levenscyclus (start/stop/install/delete)

	mu            sync.Mutex
	spec          spec.ServerSpec
	ready         *regexp.Regexp
	installedAt   *time.Time
	installFailed bool
	installError  string
	installing    bool // install loopt of staat in de wachtrij
	installCancel context.CancelFunc
	state         string
	run           *run
	startedAt     *time.Time
	console       *Ring
	installLog    *Ring
	subs          map[*Sub]struct{}
	sample        engine.StatsSample
	lastStatsPub  time.Time
	diskBytes     int64
	diskExceeded  bool
	diskWarned    bool
	diskStopping  bool
	diskGrowth    int64 // recente groei (afnemend gemiddelde)
	deleted       bool
	sleepL        *mcproto.Listener
	sleepPending  bool // stop wegens slaapstand loopt: exit → sleeping
	idleSince     time.Time
	wasSleeping   bool        // uit de opgeslagen staat (Recover)
	restarts      []time.Time // automatische herstarts in het laatste venster
	restartCancel context.CancelFunc
}

func (s *Server) UUID() string { return s.uuid }

// Spec geeft een kopie van de huidige spec.
func (s *Server) Spec() spec.ServerSpec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.spec
}

// View geeft de huidige ServerState.
func (s *Server) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewLocked()
}

func (s *Server) viewLocked() View {
	return View{UUID: s.uuid, State: s.state, DiskBytes: s.diskBytes, DiskExceeded: s.diskExceeded, StartedAt: s.startedAt, InstalledAt: s.installedAt}
}

// State geeft alleen de toestand.
func (s *Server) State() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// Stats geeft de laatste meting.
func (s *Server) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statsLocked()
}

func (s *Server) statsLocked() Stats {
	st := Stats{DiskBytes: s.diskBytes, DiskLimitBytes: int64(s.spec.Limits.DiskMB) * 1024 * 1024}
	if s.run == nil || s.startedAt == nil {
		return st
	}
	st.CPUPct = s.sample.CPUPct
	st.MemoryBytes = s.sample.MemoryBytes
	st.MemoryLimitBytes = int64(s.spec.Limits.MemoryMB) * 1024 * 1024
	st.NetworkRxBytes = s.sample.RxBytes
	st.NetworkTxBytes = s.sample.TxBytes
	st.UptimeMs = time.Since(*s.startedAt).Milliseconds()
	if st.UptimeMs < 0 {
		st.UptimeMs = 0
	}
	return st
}

// Logs geeft de laatste n consoleregels.
func (s *Server) Logs(n int) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.console.Last(n)
}

func (s *Server) persistLocked() error {
	p := persisted{Spec: s.spec, InstalledAt: s.installedAt, InstallFailed: s.installFailed, InstallError: s.installError,
		Sleeping: s.state == StateSleeping}
	return s.m.writeState(s.uuid, p)
}

func (s *Server) persist() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleted {
		return
	}
	if err := s.persistLocked(); err != nil {
		s.m.log.Error("saving state failed", "uuid", s.uuid, "err", err)
	}
}

// ---------- berichten naar websockets ----------

func encode(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func (s *Server) publishLocked(v any) {
	if len(s.subs) == 0 {
		return
	}
	b := encode(v)
	for sub := range s.subs {
		sub.Send(b)
	}
}

// Msg is een websocket-bericht van de daemon.
type Msg map[string]any

func (s *Server) setStateLocked(st string) {
	if s.state == st {
		return
	}
	old := s.state
	s.state = st
	if (old == StateSleeping || st == StateSleeping) && !s.deleted {
		if err := s.persistLocked(); err != nil {
			s.m.log.Warn("saving state failed", "uuid", s.uuid, "err", err)
		}
	}
	s.publishLocked(Msg{"event": "status", "state": st})
	s.m.rep.ReportStatus(s.uuid, st)
	if s.m.onState != nil {
		s.m.onState(s.uuid, st)
	}
}

func (s *Server) setState(st string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setStateLocked(st)
}

// DaemonMessage stuurt een melding van de daemon zelf naar de console.
func (s *Server) DaemonMessage(level, line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publishLocked(Msg{"event": "daemon_message", "level": level, "line": line})
}

func (s *Server) installLine(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.installLog.Add(line)
	s.publishLocked(Msg{"event": "install_output", "line": line})
}

// Subscribe registreert sub en zet eerst (atomisch met de registratie) de backlog en de
// huidige status in zijn wachtrij, zodat er geen regels wegvallen of dubbel komen.
// before wordt vóór de backlog in de wachtrij gezet (auth_success).
func (s *Server) Subscribe(sub *Sub, before []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleted {
		return false
	}
	if before != nil {
		sub.Send(before)
	}
	if s.state == StateInstalling {
		for _, l := range s.installLog.Last(0) {
			sub.Send(encode(Msg{"event": "install_output", "line": l}))
		}
	}
	for _, l := range s.console.Last(0) {
		sub.Send(encode(Msg{"event": "console_output", "line": l}))
	}
	sub.Send(encode(Msg{"event": "status", "state": s.state}))
	s.subs[sub] = struct{}{}
	return true
}

// Unsubscribe haalt sub weg.
func (s *Server) Unsubscribe(sub *Sub) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subs, sub)
}

// StatsMessage is het stats-bericht voor de websocket.
func (s *Server) StatsMessage() []byte {
	st := s.Stats()
	return encode(statsMsg(st))
}

func statsMsg(st Stats) Msg {
	return Msg{
		"event":              "stats",
		"cpu_pct":            st.CPUPct,
		"memory_bytes":       st.MemoryBytes,
		"memory_limit_bytes": st.MemoryLimitBytes,
		"network_rx_bytes":   st.NetworkRxBytes,
		"network_tx_bytes":   st.NetworkTxBytes,
		"disk_bytes":         st.DiskBytes,
		"disk_limit_bytes":   st.DiskLimitBytes,
		"uptime_ms":          st.UptimeMs,
	}
}

// ---------- console ----------

func (s *Server) onLine(r *run, line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.run != r {
		return
	}
	s.console.Add(line)
	s.publishLocked(Msg{"event": "console_output", "line": line})
	if s.state == StateStarting && s.ready != nil && s.ready.MatchString(StripANSI(line)) {
		s.setStateLocked(StateOnline)
	}
}

// SendCommand schrijft een regel naar stdin.
func (s *Server) SendCommand(cmd string) error {
	s.mu.Lock()
	r := s.run
	st := s.state
	s.mu.Unlock()
	if r == nil || (st != StateStarting && st != StateOnline) {
		return ErrNotRunning
	}
	return r.write([]byte(cmd + "\n"))
}
