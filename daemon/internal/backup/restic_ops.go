package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
)

// opForget is een job zonder voortgang (restic forget van losse snapshots): hij houdt alleen de
// plek van de server bezet, zodat er niets anders tegelijk aan de repository werkt.
const opForget = "forget"

// ResticReporter meldt het resultaat van een incrementele backup (de panel-client implementeert
// hem; r is een SnapshotResult, als any om een importcyclus te vermijden).
type ResticReporter interface {
	ReportSnapshot(id int, r any)
}

func (s *Service) resticImage() string {
	if s.ResticImage != "" {
		return s.ResticImage
	}
	return DefaultResticImage
}

// spec maakt de containerspecificatie voor een restic-commando op de repository van sv.
func (s *Service) spec(ctx context.Context, sv *server.Server, repo ResticRepo, args []string, mounts []engine.Mount) (resticSpec, error) {
	uuid := sv.UUID()
	uid, gid := s.Mgr.Owner()
	cache := filepath.Join(s.Mgr.DataDir(), "cache", "restic", uuid)
	if err := os.MkdirAll(cache, 0o700); err != nil {
		return resticSpec{}, err
	}
	if err := os.Chown(cache, uid, gid); err != nil {
		return resticSpec{}, err
	}
	sp := resticSpec{UUID: uuid, Image: s.resticImage(), Repo: repo, Args: args, Mounts: mounts, Cache: cache, UID: uid, GID: gid, Labels: s.Mgr.TempLabels(uuid)}
	if s.ResticLocalRepo != "" {
		sp.LocalRepo = filepath.Join(s.ResticLocalRepo, uuid)
		if err := os.MkdirAll(sp.LocalRepo, 0o700); err != nil {
			return resticSpec{}, err
		}
		if err := os.Chown(sp.LocalRepo, uid, gid); err != nil {
			return resticSpec{}, err
		}
		sp.Network = "none"
		return sp, nil
	}
	// Eigen netwerk van de server: uitgaand verkeer voor S3, geen andere servers.
	if err := s.Mgr.EnsureServerNetwork(ctx, uuid); err != nil {
		return resticSpec{}, fmt.Errorf("server network: %w", err)
	}
	sp.Network = server.SiteNetwork(uuid)
	return sp, nil
}

// restic draait een commando. Is de repository vergrendeld, dan is die lock verweesd (de daemon
// voert per server één restic-operatie tegelijk uit; een gestopte of afgebroken container laat
// zijn lock achter): locks weg en één keer opnieuw.
func (s *Service) restic(ctx context.Context, sv *server.Server, repo ResticRepo, args []string, mounts []engine.Mount, fn func(resticMsg)) error {
	sp, err := s.spec(ctx, sv, repo, args, mounts)
	if err != nil {
		return err
	}
	err = s.runRestic(ctx, sp, fn)
	if resticCode(err) == resticExitLocked {
		s.Log.Warn("restic repository locked; removing stale locks", "uuid", sv.UUID())
		if uerr := s.unlock(ctx, sv, repo); uerr == nil {
			err = s.runRestic(ctx, sp, fn)
		}
	}
	return err
}

func (s *Service) unlock(ctx context.Context, sv *server.Server, repo ResticRepo) error {
	sp, err := s.spec(ctx, sv, repo, []string{"unlock", "--remove-all"}, nil)
	if err != nil {
		return err
	}
	return s.runRestic(ctx, sp, nil)
}

// releaseLocks ruimt na een mislukte of afgebroken operatie de lock op die de container achterliet.
func (s *Service) releaseLocks(sv *server.Server, repo ResticRepo) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := s.unlock(ctx, sv, repo); err != nil {
		s.Log.Warn("restic unlock failed", "uuid", sv.UUID(), "err", scrubRepo(err.Error(), repo, nil))
	}
}

// ---------- backup ----------

// StartResticBackup start een incrementele backup op de achtergrond; het resultaat gaat naar het panel.
func (s *Service) StartResticBackup(sv *server.Server, req ResticBackupRequest) error {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
	j := s.begin(sv.UUID(), req.BackupID, "backup", PhasePreparing, cancel)
	if j == nil {
		cancel()
		return ErrBusy
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.end(sv.UUID())
		defer cancel()
		stop := s.ticker(sv, j)
		res, err := s.runResticBackup(ctx, sv, j, req)
		stop()
		if err != nil {
			s.releaseLocks(sv, req.ResticRepo)
		}
		s.finish(sv, j, err)
		if err != nil {
			msg := scrubRepo(err.Error(), req.ResticRepo, req.Databases)
			if j.isCancelled() {
				msg = CancelledMsg
			}
			s.Log.Warn("incremental backup failed", "uuid", sv.UUID(), "backup", req.BackupID, "err", msg)
			s.Rep.ReportBackup(req.BackupID, false, "", 0, msg)
			return
		}
		if rr, ok := s.Rep.(ResticReporter); ok {
			rr.ReportSnapshot(req.BackupID, res)
			return
		}
		s.Rep.ReportBackup(req.BackupID, false, "", 0, "panel client cannot report snapshots")
	}()
	return nil
}

// dumpAll maakt de database-dumps in een tijdelijke map (leeg pad zonder databases).
func (s *Service) dumpAll(ctx context.Context, sv *server.Server, j *job, dbs []Database) (string, error) {
	if len(dbs) == 0 {
		return "", nil
	}
	if err := j.enter(PhaseDumping, 0); err != nil {
		return "", err
	}
	dir, err := s.tmpDir("backup-" + sv.UUID() + "-")
	if err != nil {
		return "", err
	}
	uid, gid := s.Mgr.Owner()
	if err := os.Chown(dir, uid, gid); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	for _, db := range dbs {
		if err := s.dump(ctx, sv, db, dir); err != nil {
			os.RemoveAll(dir)
			return "", fmt.Errorf("dump of database %s: %w", db.Name, err)
		}
	}
	return dir, nil
}

func (s *Service) runResticBackup(ctx context.Context, sv *server.Server, j *job, req ResticBackupRequest) (SnapshotResult, error) {
	var res SnapshotResult
	if err := req.ResticRepo.Validate(); err != nil {
		return res, err
	}
	if err := ValidateDatabases(req.Databases); err != nil {
		return res, err
	}
	dumpDir, err := s.dumpAll(ctx, sv, j, req.Databases)
	if err != nil {
		if j.isCancelled() {
			return res, errCancelled
		}
		return res, err
	}
	if dumpDir != "" {
		defer os.RemoveAll(dumpDir)
	}
	if err := j.enter(PhaseArchiving, 0); err != nil {
		return res, err
	}
	mounts := []engine.Mount{{Source: s.Mgr.Volume(sv.UUID()), Target: resticData, ReadOnly: true}}
	if dumpDir != "" {
		mounts = append(mounts, engine.Mount{Source: dumpDir, Target: resticDumps, ReadOnly: true})
	}
	var summary resticMsg
	onMsg := func(m resticMsg) {
		switch m.MessageType {
		case "status":
			if m.TotalBytes > 0 {
				j.setTotal(m.TotalBytes)
			}
			j.bytes.Store(m.BytesDone)
		case "summary":
			summary = m
		}
	}
	args := backupArgs(req.BackupID, req.Ignore, dumpDir != "")
	err = s.restic(ctx, sv, req.ResticRepo, args, mounts, onMsg)
	if resticCode(err) == resticExitNoRepo {
		// Eerste incrementele backup van deze server: repository aanmaken.
		if err = s.restic(ctx, sv, req.ResticRepo, []string{"init", "--json"}, nil, nil); err == nil {
			err = s.restic(ctx, sv, req.ResticRepo, args, mounts, onMsg)
		}
	}
	if j.isCancelled() {
		return res, errCancelled
	}
	if err != nil {
		return res, fmt.Errorf("restic backup: %w", err)
	}
	if !ValidSnapshotID(summary.SnapshotID) {
		return res, errors.New("restic backup: no snapshot id in the output")
	}
	if err := j.advance(PhaseFinishing); err != nil {
		// Annulering kwam binnen terwijl restic al klaar was: de snapshot weer weg.
		fctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		_ = s.restic(fctx, sv, req.ResticRepo, []string{"forget", summary.SnapshotID}, nil, nil)
		cancel()
		return res, err
	}
	res = SnapshotResult{SnapshotID: summary.SnapshotID, TotalBytes: summary.TotalBytesProcessed, AddedBytes: summary.DataAddedPacked, Forgotten: []string{}}
	if req.Retention != nil && !req.Retention.empty() {
		var raw string
		ferr := s.restic(ctx, sv, req.ResticRepo, forgetArgs(*req.Retention, req.Prune), nil, func(m resticMsg) {
			if m.MessageType == "array" {
				raw = m.Message
			}
		})
		if ferr == nil && raw != "" {
			if ids, perr := forgotten(raw); perr == nil {
				res.Forgotten = ids
			}
		}
		if ferr != nil {
			// De backup zelf is gelukt; de retentie loopt de volgende keer opnieuw.
			s.Log.Warn("restic forget failed", "uuid", sv.UUID(), "err", scrubRepo(ferr.Error(), req.ResticRepo, nil))
		} else {
			res.Pruned = req.Prune
		}
	}
	return res, nil
}

// ---------- herstel ----------

// StartResticRestore start een herstel van een snapshot (heel of losse paden) op de achtergrond.
func (s *Service) StartResticRestore(sv *server.Server, backupID int, req ResticRestoreRequest) error {
	if err := validateRestore(&req); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
	phase := PhaseStopping
	if len(req.Paths) > 0 {
		phase = PhaseDownloading
	}
	j := s.begin(sv.UUID(), backupID, "restore", phase, cancel)
	if j == nil {
		cancel()
		return ErrBusy
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.end(sv.UUID())
		defer cancel()
		stop := s.ticker(sv, j)
		var err error
		if len(req.Paths) > 0 {
			err = s.runResticRestorePaths(ctx, sv, j, req)
		} else {
			err = s.runResticRestoreFull(ctx, sv, j, req)
		}
		stop()
		if err != nil {
			s.releaseLocks(sv, req.ResticRepo)
		}
		s.finish(sv, j, err)
		if err != nil {
			msg := scrubRepo(err.Error(), req.ResticRepo, req.Databases)
			if j.isCancelled() {
				sv.DaemonMessage("info", "restore cancelled; the server data was not changed")
				s.Rep.ReportRestore(backupID, false, CancelledMsg)
				return
			}
			s.Log.Warn("incremental restore failed", "uuid", sv.UUID(), "backup", backupID, "err", msg)
			sv.DaemonMessage("error", "restore failed: "+msg)
			s.Rep.ReportRestore(backupID, false, msg)
			return
		}
		s.Rep.ReportRestore(backupID, true, "")
	}()
	return nil
}

// ErrInvalid: het verzoek is ongeldig (API: 400).
var ErrInvalid = errors.New("invalid request")

// validateRestore controleert het verzoek en maakt de paden schoon (relatief aan /home/container).
func validateRestore(req *ResticRestoreRequest) error {
	if err := req.ResticRepo.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if !ValidSnapshotID(req.SnapshotID) {
		return fmt.Errorf("%w: invalid snapshot id", ErrInvalid)
	}
	if err := ValidateDatabases(req.Databases); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if len(req.Paths) > MaxRestorePaths {
		return fmt.Errorf("%w: at most %d paths", ErrInvalid, MaxRestorePaths)
	}
	seen := map[string]bool{}
	clean := []string{}
	for _, p := range req.Paths {
		c, err := CleanRel(p)
		if err != nil || c == "." {
			return fmt.Errorf("%w: invalid path %q", ErrInvalid, p)
		}
		if !seen[c] {
			seen[c] = true
			clean = append(clean, c)
		}
	}
	if len(req.Paths) > 0 {
		req.Paths = clean
	}
	if req.Destination != "" {
		if len(req.Paths) == 0 {
			return fmt.Errorf("%w: destination needs paths", ErrInvalid)
		}
		d, err := CleanRel(req.Destination)
		if err != nil || d == "." {
			return fmt.Errorf("%w: invalid destination", ErrInvalid)
		}
		req.Destination = d
	}
	return nil
}

// restoreDir maakt een tijdelijke map naast de serverdata (zelfde bestandssysteem), eigendom van uid.
func (s *Service) restoreDir(uuid string) (string, error) {
	uid, gid := s.Mgr.Owner()
	tmp, err := os.MkdirTemp(filepath.Dir(s.Mgr.Volume(uuid)), ".restore-"+uuid+"-")
	if err != nil {
		return "", err
	}
	if err := os.Chown(tmp, uid, gid); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	if err := os.Chmod(tmp, 0o750); err != nil {
		os.RemoveAll(tmp)
		return "", err
	}
	return tmp, nil
}

// restoreInto draait restic restore naar tmp en houdt de voortgang bij.
func (s *Service) restoreInto(ctx context.Context, sv *server.Server, j *job, req ResticRestoreRequest, tmp string) error {
	err := s.restic(ctx, sv, req.ResticRepo, restoreArgs(req.SnapshotID, req.Paths), []engine.Mount{{Source: tmp, Target: resticRestore}}, func(m resticMsg) {
		if m.MessageType == "status" || m.MessageType == "summary" {
			if m.TotalBytes > 0 {
				j.setTotal(m.TotalBytes)
			}
			j.bytes.Store(m.BytesRestored)
		}
	})
	if j.isCancelled() {
		return errCancelled
	}
	if err != nil {
		return fmt.Errorf("restic restore: %w", err)
	}
	return nil
}

func (s *Service) runResticRestoreFull(ctx context.Context, sv *server.Server, j *job, req ResticRestoreRequest) error {
	uuid := sv.UUID()
	vol := s.Mgr.Volume(uuid)
	wasRunning := sv.WasRunning()
	release, err := sv.HoldStopped()
	if err != nil {
		return fmt.Errorf("stopping server: %w", err)
	}
	defer func() {
		release()
		if wasRunning {
			sv.StartAfter()
		}
	}()
	if err := j.enter(PhaseDownloading, 0); err != nil {
		return err
	}
	tmp, err := s.restoreDir(uuid)
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := s.restoreInto(ctx, sv, j, req, tmp); err != nil {
		return err
	}
	if err := j.advance(PhaseApplying); err != nil {
		return err
	}
	uid, gid := s.Mgr.Owner()
	data := filepath.Join(tmp, "home", "container")
	if _, err := os.Lstat(data); err != nil {
		if err := os.MkdirAll(data, 0o750); err != nil {
			return err
		}
	}
	if err := os.Chown(data, uid, gid); err != nil {
		return err
	}
	if err := s.swapIn(ctx, sv, vol, data, filepath.Join(tmp, strings.TrimPrefix(resticDumps, "/")), req.Databases); err != nil {
		return err
	}
	_ = j.advance(PhaseFinishing)
	return nil
}

// swapIn zet data op de plek van vol en herstelt de databases uit dumpDir. Mislukt een database,
// dan komen de oude bestanden terug.
func (s *Service) swapIn(ctx context.Context, sv *server.Server, vol, data, dumpDir string, dbs []Database) error {
	parent := filepath.Dir(vol)
	old := ""
	if _, serr := os.Lstat(vol); serr == nil {
		old = filepath.Join(parent, ".old-"+sv.UUID()+"-"+strconv.FormatInt(time.Now().UnixNano(), 36))
		if err := os.Rename(vol, old); err != nil {
			return fmt.Errorf("moving old data aside: %w", err)
		}
	}
	if err := os.Rename(data, vol); err != nil {
		if old != "" {
			_ = os.Rename(old, vol)
		}
		return fmt.Errorf("moving restored data into place: %w", err)
	}
	for _, db := range dbs {
		if _, serr := os.Stat(filepath.Join(dumpDir, db.Name+".sql")); serr != nil {
			s.Log.Warn("database not in snapshot, skipped", "uuid", sv.UUID(), "db", db.Name)
			continue
		}
		if err := s.load(ctx, sv, db, dumpDir); err != nil {
			if old != "" {
				failed := vol + ".failed"
				if os.Rename(vol, failed) == nil {
					if os.Rename(old, vol) == nil {
						_ = os.RemoveAll(failed)
					}
				}
			}
			return fmt.Errorf("restoring database %s (files rolled back): %w", db.Name, err)
		}
	}
	if old != "" {
		if err := os.RemoveAll(old); err != nil {
			s.Log.Warn("removing old data failed", "dir", old, "err", err)
		}
	}
	return nil
}

func (s *Service) runResticRestorePaths(ctx context.Context, sv *server.Server, j *job, req ResticRestoreRequest) error {
	uuid := sv.UUID()
	tmp, err := s.restoreDir(uuid)
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := s.restoreInto(ctx, sv, j, req, tmp); err != nil {
		return err
	}
	if err := j.advance(PhaseApplying); err != nil {
		return err
	}
	srcDir := filepath.Join(tmp, "home", "container")
	src, err := os.OpenRoot(srcDir)
	if err != nil {
		return errors.New("none of the selected paths are in the snapshot")
	}
	defer src.Close()
	if err := sv.CheckWrite(treeSize(src)); err != nil {
		return err
	}
	dst, err := os.OpenRoot(s.Mgr.Volume(uuid))
	if err != nil {
		return fmt.Errorf("opening server data: %w", err)
	}
	defer dst.Close()
	uid, gid := s.Mgr.Owner()
	restored := 0
	for _, p := range req.Paths {
		if _, err := src.Lstat(p); err != nil {
			continue
		}
		to := p
		if req.Destination != "" {
			to = path.Join(req.Destination, p)
		}
		if err := copyTree(src, p, dst, to, uid, gid); err != nil {
			return fmt.Errorf("restoring %s: %w", p, err)
		}
		restored++
	}
	if restored == 0 {
		return errors.New("none of the selected paths are in the snapshot")
	}
	_ = j.advance(PhaseFinishing)
	return nil
}

func treeSize(root *os.Root) int64 {
	var n int64
	_ = fs.WalkDir(root.FS(), ".", func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

// copyTree kopieert from (bestand, map of symlink in src) naar to in dst. Bestaande bestanden
// worden overschreven, een ander soort item op dezelfde plek eerst verwijderd; wat in dst naast
// de herstelde bestanden staat blijft staan. Beide kanten zijn een os.Root: niets komt buiten de
// serverdata, ook niet via symlinks.
func copyTree(src *os.Root, from string, dst *os.Root, to string, uid, gid int) error {
	return fs.WalkDir(src.FS(), from, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := to + strings.TrimPrefix(p, from)
		info, err := d.Info()
		if err != nil {
			return err
		}
		cur, lerr := dst.Lstat(target)
		switch {
		case d.IsDir():
			if lerr == nil && !cur.IsDir() {
				if err := dst.Remove(target); err != nil {
					return err
				}
			}
			if err := mkParent(dst, target, uid, gid); err != nil {
				return err
			}
			if err := dst.MkdirAll(target, 0o755); err != nil {
				return err
			}
			if err := dst.Lchown(target, uid, gid); err != nil {
				return err
			}
			return dst.Chmod(target, info.Mode().Perm()|0o700)
		case d.Type().IsRegular():
			if lerr == nil && !cur.Mode().IsRegular() {
				if err := dst.RemoveAll(target); err != nil {
					return err
				}
			}
			if err := mkParent(dst, target, uid, gid); err != nil {
				return err
			}
			f, err := src.Open(p)
			if err != nil {
				return err
			}
			err = writeFile(dst, target, f, info.Mode().Perm(), uid, gid)
			f.Close()
			if err != nil {
				return err
			}
			_ = dst.Chtimes(target, info.ModTime(), info.ModTime())
			return nil
		case d.Type()&fs.ModeSymlink != 0:
			link, err := src.Readlink(p)
			if err != nil {
				return err
			}
			if lerr == nil {
				if err := dst.RemoveAll(target); err != nil {
					return err
				}
			}
			if err := mkParent(dst, target, uid, gid); err != nil {
				return err
			}
			if err := dst.Symlink(link, target); err != nil {
				return err
			}
			return dst.Lchown(target, uid, gid)
		}
		return nil // apparaten, sockets e.d.: overslaan
	})
}

// ---------- bladeren en verwijderen ----------

// ResticLs geeft de inhoud van één map in een snapshot (zonder lock; alleen lezen).
func (s *Service) ResticLs(ctx context.Context, sv *server.Server, req ResticLsRequest) ([]LsEntry, bool, error) {
	if err := req.ResticRepo.Validate(); err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if !ValidSnapshotID(req.SnapshotID) {
		return nil, false, fmt.Errorf("%w: invalid snapshot id", ErrInvalid)
	}
	rel, err := CleanRel(req.Path)
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	dir := resticData
	if rel != "." {
		dir += "/" + rel
	}
	entries := []LsEntry{}
	truncated := false
	err = s.restic(ctx, sv, req.ResticRepo, lsArgs(req.SnapshotID, rel), nil, func(m resticMsg) {
		e, ok := lsEntry(m, dir)
		if !ok {
			return
		}
		if len(entries) >= MaxLsEntries {
			truncated = true
			return
		}
		entries = append(entries, e)
	})
	if err != nil {
		return nil, false, fmt.Errorf("restic ls: %s", scrubRepo(err.Error(), req.ResticRepo, nil))
	}
	sort.Slice(entries, func(a, b int) bool {
		da, db := entries[a].Type == "dir", entries[b].Type == "dir"
		if da != db {
			return da
		}
		return entries[a].Name < entries[b].Name
	})
	return entries, truncated, nil
}

// ResticForget verwijdert snapshots (zonder prune: dat doet het retentiebeleid). Snapshots die er
// al niet meer zijn gelden als verwijderd.
func (s *Service) ResticForget(ctx context.Context, sv *server.Server, req ResticForgetRequest) error {
	if err := req.ResticRepo.Validate(); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if len(req.SnapshotIDs) == 0 || len(req.SnapshotIDs) > 100 {
		return fmt.Errorf("%w: 1 to 100 snapshot ids", ErrInvalid)
	}
	for _, id := range req.SnapshotIDs {
		if !ValidSnapshotID(id) {
			return fmt.Errorf("%w: invalid snapshot id", ErrInvalid)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if s.begin(sv.UUID(), 0, opForget, PhaseFinishing, cancel) == nil {
		return ErrBusy
	}
	defer s.end(sv.UUID())
	err := s.restic(ctx, sv, req.ResticRepo, append([]string{"forget"}, req.SnapshotIDs...), nil, nil)
	var re *ResticError
	if errors.As(err, &re) && (strings.Contains(re.Msg, "no matching ID found") || re.Code == resticExitNoRepo) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("restic forget: %s", scrubRepo(err.Error(), req.ResticRepo, nil))
	}
	return nil
}
