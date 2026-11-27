package server

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// FreeSpace geeft totaal en vrij (voor niet-root) in bytes van het bestandssysteem van dir.
func FreeSpace(dir string) (total, free int64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, 0, err
	}
	return int64(st.Blocks) * int64(st.Bsize), int64(st.Bavail) * int64(st.Bsize), nil
}

// FreeWatch stopt bij minder dan 5% vrije schijf de draaiende server die sinds zijn
// vorige meting het snelst groeide. Draait tot de manager sluit.
func (m *Manager) FreeWatch(interval time.Duration, statfs func(string) (int64, int64, error)) {
	if statfs == nil {
		statfs = FreeSpace
	}
	var lastStop time.Time
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-t.C:
		}
		total, free, err := statfs(m.cfg.DataDir)
		if err != nil || total <= 0 || free*100 >= total*5 {
			continue
		}
		if time.Since(lastStop) < 4*interval {
			continue // de vorige stop eerst laten doorwerken
		}
		var worst *Server
		var growth int64
		for _, s := range m.List() {
			s.mu.Lock()
			g, running := s.diskGrowth, s.run != nil && !s.diskStopping
			s.mu.Unlock()
			if running && (worst == nil || g > growth) {
				worst, growth = s, g
			}
		}
		if worst == nil {
			m.log.Warn("less than 5% free disk, no running server to stop", "free", free, "total", total)
			continue
		}
		m.log.Warn("less than 5% free disk: server stopped", "uuid", worst.uuid, "growth", growth)
		worst.mu.Lock()
		worst.diskStopping = true
		worst.publishLocked(Msg{"event": "daemon_message", "level": "error",
			"line": fmt.Sprintf("The node's disk is almost full (%d%% free); this server grew fastest and is being stopped.", free*100/total)})
		worst.mu.Unlock()
		lastStop = time.Now()
		go worst.stopForDisk()
	}
}

// DetectXFSPrjquota geeft true als dir op XFS met project quota staat.
func DetectXFSPrjquota(dir string) bool {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	if p, err := filepath.EvalSymlinks(abs); err == nil {
		abs = p
	}
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	defer f.Close()
	best, fstype, opts := "", "", ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// id parent maj:min root mountpoint opts ... - fstype source superopts
		fields := strings.Fields(sc.Text())
		sep := -1
		for i, x := range fields {
			if x == "-" {
				sep = i
				break
			}
		}
		if len(fields) < 6 || sep < 0 || sep+3 >= len(fields) {
			continue
		}
		mp := fields[4]
		if (abs == mp || strings.HasPrefix(abs, strings.TrimSuffix(mp, "/")+"/")) && len(mp) >= len(best) {
			best, fstype, opts = mp, fields[sep+1], fields[5]+","+fields[sep+3]
		}
	}
	if fstype != "xfs" {
		return false
	}
	for _, o := range strings.Split(opts, ",") {
		if o == "prjquota" || o == "pquota" || o == "pqnoenforce" {
			return true
		}
	}
	return false
}
