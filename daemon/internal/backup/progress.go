package backup

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"panel/daemon/internal/server"
)

// Fasen van een backup of herstel (BackupProgress.phase in openapi.yaml).
const (
	PhasePreparing   = "preparing"   // backup: data meten
	PhaseDumping     = "dumping"     // backup: database-dumps
	PhaseArchiving   = "archiving"   // backup: tar.zst streamen naar S3
	PhaseStopping    = "stopping"    // herstel: server stoppen
	PhaseDownloading = "downloading" // herstel: downloaden, checksum en uitpakken naar een tijdelijke map
	PhaseApplying    = "applying"    // herstel: data omwisselen en databases terugzetten
	PhaseFinishing   = "finishing"   // afronden (niet meer te annuleren)
	PhaseDone        = "done"
	PhaseFailed      = "failed"
	PhaseCancelled   = "cancelled"
)

// CancelledMsg is de foutmelding naar het panel bij een geannuleerde backup of herstel.
const CancelledMsg = "cancelled"

var (
	// ErrNotRunning: voor deze server loopt (deze) backup of herstel niet.
	ErrNotRunning = errors.New("no backup or restore with this id is running for this server")
	// ErrNotCancellable: het herstel is al aan het omwisselen of het werk is bijna klaar.
	ErrNotCancellable = errors.New("this backup or restore can no longer be cancelled")
	errCancelled      = errors.New(CancelledMsg)
)

// Progress is BackupProgress uit openapi.yaml.
type Progress struct {
	BackupID    int       `json:"backup_id"`
	Operation   string    `json:"operation"` // backup | restore
	Phase       string    `json:"phase"`
	Bytes       int64     `json:"bytes"`
	TotalBytes  int64     `json:"total_bytes"` // 0 = onbekend
	Percent     int       `json:"percent"`
	EtaSeconds  *int64    `json:"eta_seconds"` // null = onbekend
	StartedAt   time.Time `json:"started_at"`
	Cancellable bool      `json:"cancellable"`
}

// job is een lopende backup of herstel van één server.
type job struct {
	id      int
	op      string
	started time.Time
	cancel  context.CancelFunc
	bytes   atomic.Int64 // verwerkt in de huidige fase

	mu        sync.Mutex
	phase     string
	phaseAt   time.Time
	total     int64
	cancelled bool
}

func cancellable(op, phase string) bool {
	switch phase {
	case PhasePreparing, PhaseDumping, PhaseArchiving:
		return op == "backup"
	case PhaseStopping, PhaseDownloading:
		return op == "restore"
	}
	return false
}

// enter zet de volgende fase (bytes weer op 0). Is de job geannuleerd, dan geeft hij errCancelled:
// zo kan een annulering nooit tussen de controle en een niet-omkeerbare stap vallen.
func (j *job) enter(phase string, total int64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.cancelled {
		return errCancelled
	}
	j.phase, j.phaseAt, j.total = phase, time.Now(), total
	j.bytes.Store(0)
	return nil
}

// advance is enter zonder de tellers te wissen.
func (j *job) advance(phase string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.cancelled {
		return errCancelled
	}
	j.phase, j.phaseAt = phase, time.Now()
	return nil
}

func (j *job) setTotal(total int64) {
	j.mu.Lock()
	j.total = total
	j.mu.Unlock()
}

func (j *job) isCancelled() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.cancelled
}

func (j *job) snapshot(now time.Time) Progress {
	j.mu.Lock()
	phase, at, total := j.phase, j.phaseAt, j.total
	j.mu.Unlock()
	n := j.bytes.Load()
	p := Progress{BackupID: j.id, Operation: j.op, Phase: phase, Bytes: n, TotalBytes: total, StartedAt: j.started, Cancellable: cancellable(j.op, phase)}
	switch phase {
	case PhaseArchiving, PhaseDownloading:
		if total > 0 {
			p.Percent = int(min(n*99/total, 99))
		}
		p.EtaSeconds = eta(n, total, now.Sub(at))
	case PhaseApplying, PhaseFinishing:
		p.Percent = 99
	case PhaseDone:
		p.Percent = 100
		zero := int64(0)
		p.EtaSeconds = &zero
	}
	return p
}

// eta schat de resterende tijd uit het gemiddelde tempo van de fase; nil zolang dat niet te zeggen is.
func eta(done, total int64, elapsed time.Duration) *int64 {
	if total <= 0 || done <= 0 || elapsed < 500*time.Millisecond {
		return nil
	}
	left := total - done
	if left <= 0 {
		z := int64(0)
		return &z
	}
	secs := int64(float64(left) / (float64(done) / elapsed.Seconds()))
	return &secs
}

// begin registreert een nieuwe job; nil als er al iets loopt voor deze server.
func (s *Service) begin(uuid string, id int, op, phase string, cancel context.CancelFunc) *job {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.jobs == nil {
		s.jobs = map[string]*job{}
	}
	if s.jobs[uuid] != nil {
		return nil
	}
	now := time.Now()
	j := &job{id: id, op: op, started: now, cancel: cancel, phase: phase, phaseAt: now}
	s.jobs[uuid] = j
	return j
}

func (s *Service) end(uuid string) {
	s.mu.Lock()
	delete(s.jobs, uuid)
	s.mu.Unlock()
}

// Progress geeft de voortgang van de lopende backup of het lopende herstel van een server.
func (s *Service) Progress(uuid string) (Progress, bool) {
	s.mu.Lock()
	j := s.jobs[uuid]
	s.mu.Unlock()
	if j == nil || j.op == opForget {
		return Progress{}, false
	}
	return j.snapshot(time.Now()), true
}

// Cancel breekt een lopende backup (altijd tot het afronden) of een herstel (alleen vóór het
// omwisselen van de data, dus de oude data blijft heel) af. Het resultaat gaat zoals altijd naar
// het panel, met de fout "cancelled".
func (s *Service) Cancel(uuid string, id int) error {
	s.mu.Lock()
	j := s.jobs[uuid]
	s.mu.Unlock()
	if j == nil || j.id != id {
		return ErrNotRunning
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.cancelled {
		return nil
	}
	if !cancellable(j.op, j.phase) {
		return ErrNotCancellable
	}
	j.cancelled = true
	j.cancel()
	return nil
}

func (s *Service) publish(sv *server.Server, p Progress) {
	m := server.Msg{"event": "backup_progress", "backup_id": p.BackupID, "operation": p.Operation, "phase": p.Phase,
		"bytes": p.Bytes, "total_bytes": p.TotalBytes, "percent": p.Percent, "cancellable": p.Cancellable}
	if p.EtaSeconds != nil {
		m["eta_seconds"] = *p.EtaSeconds
	} else {
		m["eta_seconds"] = nil
	}
	sv.Publish(m)
}

// ticker publiceert elke ProgressEvery backup_progress tot de teruggegeven stop wordt aangeroepen.
func (s *Service) ticker(sv *server.Server, j *job) (stop func()) {
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(s.progressEvery())
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.publish(sv, j.snapshot(time.Now()))
			}
		}
	}()
	return func() { close(done); wg.Wait() }
}

// finish publiceert de eindstand (done, failed of cancelled).
func (s *Service) finish(sv *server.Server, j *job, err error) {
	p := j.snapshot(time.Now())
	p.Cancellable = false
	p.EtaSeconds = nil
	switch {
	case err == nil:
		p.Phase, p.Percent = PhaseDone, 100
		z := int64(0)
		p.EtaSeconds = &z
	case j.isCancelled():
		p.Phase = PhaseCancelled
	default:
		p.Phase = PhaseFailed
	}
	s.publish(sv, p)
}
