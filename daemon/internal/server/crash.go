package server

import (
	"bufio"
	"context"
	"fmt"
	"strings"
	"time"

	"panel/daemon/internal/panel"
)

const (
	crashLogLines     = 30
	crashWindow       = 10 * time.Minute
	crashBackoffMax   = 2 * time.Minute
	crashReportMax    = 4000
	crashReportBudget = 40 // regels
)

// isCrash bepaalt of een exit een crash was: niet gevraagd (geen stop, slaapstand of
// schijfstop, server niet verwijderd) en met een exitcode != 0 of een OOM-kill. Exitcode 0
// is een bewuste afsluiting (bv. `stop` in de console) en geen crash.
func isCrash(wasStopping, sleepPending, diskExceeded, deleted bool, code int, waitErr error, oom bool) bool {
	if wasStopping || sleepPending || diskExceeded || deleted {
		return false
	}
	return oom || code != 0 || waitErr != nil
}

// onCrash meldt de crash aan het panel en plant zo nodig een herstart.
func (s *Server) onCrash(code int, oom bool, tail []string, startedAt time.Time) {
	sp := s.Spec()
	ev := panel.Event{Type: "crashed", ExitCode: &code, OOM: oom, LogTail: tail, Restart: "disabled"}
	if rep := s.crashReport(startedAt); rep != "" {
		ev.CrashReport = &rep
	}

	var delay time.Duration
	var rctx context.Context
	s.mu.Lock()
	if sp.AutoRestart != nil && !s.deleted && s.ctx.Err() == nil {
		now := time.Now()
		kept := s.restarts[:0]
		for _, t := range s.restarts {
			if now.Sub(t) < crashWindow {
				kept = append(kept, t)
			}
		}
		s.restarts = kept
		if len(s.restarts) >= sp.AutoRestart.MaxPer10Min {
			ev.Restart = "gave_up"
			ev.RestartAttempt = len(s.restarts)
		} else {
			delay = s.m.restartBackoff()
			for i := 0; i < len(s.restarts) && delay < crashBackoffMax; i++ {
				delay *= 3
			}
			if delay > crashBackoffMax {
				delay = crashBackoffMax
			}
			s.restarts = append(s.restarts, now)
			ev.Restart, ev.RestartAttempt = "restarted", len(s.restarts)
			if s.restartCancel != nil {
				s.restartCancel()
			}
			var cancel context.CancelFunc
			rctx, cancel = context.WithCancel(s.ctx)
			s.restartCancel = cancel
		}
	}
	reason := fmt.Sprintf("exit code %d", code)
	if oom {
		reason += ", out of memory"
	}
	switch ev.Restart {
	case "restarted":
		s.publishLocked(Msg{"event": "daemon_message", "level": "error", "line": fmt.Sprintf("Server crashed (%s). Restarting in %s (attempt %d of %d).", reason, delay.Round(time.Second), ev.RestartAttempt, sp.AutoRestart.MaxPer10Min)})
	case "gave_up":
		s.publishLocked(Msg{"event": "daemon_message", "level": "error", "line": fmt.Sprintf("Server crashed (%s). Auto-restart gave up after %d restarts in 10 minutes.", reason, sp.AutoRestart.MaxPer10Min)})
	default:
		s.publishLocked(Msg{"event": "daemon_message", "level": "error", "line": fmt.Sprintf("Server crashed (%s).", reason)})
	}
	s.mu.Unlock()

	s.m.rep.ReportEvent(s.uuid, ev)
	if rctx != nil {
		go s.autoRestart(rctx, delay)
	}
}

func (m *Manager) restartBackoff() time.Duration {
	if m.cfg.RestartBackoff > 0 {
		return m.cfg.RestartBackoff
	}
	return 5 * time.Second
}

// autoRestart wacht de backoff af en start de server, tenzij er intussen iets anders gebeurde.
func (s *Server) autoRestart(ctx context.Context, delay time.Duration) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(delay):
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if ctx.Err() != nil || s.State() != StateOffline {
		return
	}
	if err := s.doStart(); err != nil && s.ctx.Err() == nil {
		s.m.log.Warn("automatic restart failed", "uuid", s.uuid, "err", err)
		s.DaemonMessage("error", "automatic restart failed: "+err.Error())
	}
}

// cancelAutoRestart breekt een geplande herstart af (bij elke handmatige power-actie).
func (s *Server) cancelAutoRestart() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.restartCancel != nil {
		s.restartCancel()
		s.restartCancel = nil
	}
}

// crashReport leest de eerste regels van het nieuwste crash-report (Minecraft:
// crash-reports/*.txt) dat na de start van deze run is geschreven. Leeg als er geen is.
func (s *Server) crashReport(since time.Time) string {
	root := s.Root()
	list, err := root.List("crash-reports")
	if err != nil {
		return ""
	}
	var best string
	var bestT time.Time
	for _, e := range list {
		if e.IsDirectory || e.IsSymlink || !strings.HasSuffix(e.Name, ".txt") {
			continue
		}
		if e.ModifiedAt.Before(since.Add(-2*time.Second)) || !e.ModifiedAt.After(bestT) {
			continue
		}
		best, bestT = e.Name, e.ModifiedAt
	}
	if best == "" {
		return ""
	}
	f, _, err := root.OpenRead("crash-reports/" + best)
	if err != nil {
		return ""
	}
	defer f.Close()
	var b strings.Builder
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for i := 0; i < crashReportBudget && sc.Scan() && b.Len() < crashReportMax; i++ {
		b.WriteString(sc.Text())
		b.WriteByte('\n')
	}
	out := b.String()
	if len(out) > crashReportMax {
		out = out[:crashReportMax]
	}
	return strings.TrimSpace(out)
}
