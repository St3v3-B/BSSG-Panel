package server

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"time"

	"panel/daemon/internal/files"
)

// ErrDiskExceeded: de softe disk-limiet is bereikt (API: 507 bij schrijven, 409 bij start).
var ErrDiskExceeded = errors.New("disk-limiet van de server bereikt")

// Root geeft veilige toegang tot de data-map.
func (s *Server) Root() *files.Root {
	return files.New(s.m.volume(s.uuid), s.m.cfg.UID, s.m.cfg.GID)
}

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

func (s *Server) limitLocked() int64 { return int64(s.spec.Limits.DiskMB) * mib }

// DiskExceeded geeft aan of de server boven zijn disk-limiet zit.
func (s *Server) DiskExceeded() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.diskExceeded
}

// CheckWrite geeft ErrDiskExceeded als er niet extra bytes bij mogen.
func (s *Server) CheckWrite(extra int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.diskExceeded {
		return ErrDiskExceeded
	}
	if l := s.limitLocked(); l > 0 && extra > 0 && s.diskBytes+extra > l {
		return ErrDiskExceeded
	}
	return nil
}

// Budget is wat er nog geschreven mag worden.
func (s *Server) Budget() files.Budget {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.limitLocked()
	if l <= 0 {
		return files.Unlimited
	}
	if s.diskExceeded || s.diskBytes >= l {
		return 0
	}
	return files.Budget(l - s.diskBytes)
}

// AddDisk past de gemeten grootte aan na een schrijfactie via de daemon (tot de volgende
// meting). Overschrijden zet alleen de vlag niet; dat doet de meting.
func (s *Server) AddDisk(delta int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.diskBytes += delta
	if s.diskBytes < 0 {
		s.diskBytes = 0
	}
}

func (s *Server) measureDisk() {
	n, err := DirSize(s.m.volume(s.uuid))
	if err != nil {
		s.m.log.Debug("disk meten", "uuid", s.uuid, "err", err)
	}
	s.applyDisk(n)
}

// applyDisk zet de gemeten grootte en handhaaft de limiet.
func (s *Server) applyDisk(n int64) {
	s.mu.Lock()
	s.diskBytes = n
	stop := s.evaluateDiskLocked()
	s.mu.Unlock()
	if stop {
		go s.stopForDisk()
	}
}

func mb(n int64) int64 { return n / mib }

// evaluateDiskLocked waarschuwt bij 90%, markeert boven 100% en geeft true als de
// draaiende server gestopt moet worden.
func (s *Server) evaluateDiskLocked() bool {
	if s.deleted {
		return false
	}
	limit := s.limitLocked()
	n := s.diskBytes
	if limit <= 0 || n <= limit {
		if s.diskExceeded {
			s.diskExceeded = false
			if s.state == StateDiskExceeded {
				s.setStateLocked(StateOffline)
			}
			s.publishLocked(Msg{"event": "daemon_message", "level": "info", "line": "Schijfgebruik weer onder de limiet; de server kan starten."})
		}
		if limit <= 0 || n*100 < limit*85 {
			s.diskWarned = false
		}
	}
	if limit <= 0 {
		return false
	}
	if n*10 >= limit*9 && !s.diskWarned {
		s.diskWarned = true
		s.publishLocked(Msg{"event": "daemon_message", "level": "warning",
			"line": fmt.Sprintf("Schijfgebruik %d van %d MB (%d%%). Bij 100%% wordt de server gestopt.", mb(n), mb(limit), n*100/limit)})
	}
	if n <= limit {
		return false
	}
	if !s.diskExceeded {
		s.diskExceeded = true
		s.publishLocked(Msg{"event": "daemon_message", "level": "error",
			"line": fmt.Sprintf("Disk-limiet overschreden (%d van %d MB): server wordt gestopt en schrijven is geblokkeerd.", mb(n), mb(limit))})
	}
	if s.run != nil {
		if s.diskStopping {
			return false
		}
		s.diskStopping = true
		return true
	}
	if s.state == StateOffline {
		s.setStateLocked(StateDiskExceeded)
	}
	return false
}

func (s *Server) stopForDisk() {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if err := s.doStop(false); err != nil && s.ctx.Err() == nil {
		s.m.log.Warn("stoppen wegens disk mislukt", "uuid", s.uuid, "err", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.diskStopping = false
	if s.diskExceeded && s.run == nil && s.state == StateOffline {
		s.setStateLocked(StateDiskExceeded)
	}
}

// diskLoop meet elke DiskInterval, met een vaste verschuiving per server zodat niet alle
// metingen tegelijk vallen. Draait de server boven 80% van zijn limiet, dan vier keer zo vaak.
func (s *Server) diskLoop(offset time.Duration) {
	select {
	case <-s.ctx.Done():
		return
	case <-time.After(offset):
	}
	for {
		s.measureDisk()
		wait := s.m.cfg.DiskInterval
		s.mu.Lock()
		if l := s.limitLocked(); l > 0 && s.run != nil && s.diskBytes*10 >= l*8 {
			wait /= 4
		}
		s.mu.Unlock()
		select {
		case <-s.ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// RemeasureDisk meet opnieuw op de achtergrond (na verwijderen of uitpakken).
func (s *Server) RemeasureDisk() { go s.measureDisk() }
