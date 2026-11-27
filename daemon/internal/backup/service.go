package backup

import (
	"archive/tar"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
)

// DefaultDBImage bevat mariadb-dump en mariadb (dezelfde als de MariaDB in compose).
const DefaultDBImage = "mariadb:11"

// Database zijn de credentials uit DatabaseCredentials (openapi.yaml).
type Database struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// String houdt het wachtwoord uit logs.
func (d Database) String() string { return "Database{" + d.Name + "}" }

// BackupRequest is BackupRequest uit openapi.yaml.
type BackupRequest struct {
	BackupID  int        `json:"backup_id"`
	S3        S3         `json:"s3"`
	Key       string     `json:"key"`
	Ignore    []string   `json:"ignore"`
	Databases []Database `json:"databases"`
}

// RestoreRequest is RestoreRequest uit openapi.yaml.
type RestoreRequest struct {
	S3        S3         `json:"s3"`
	Key       string     `json:"key"`
	SHA256    string     `json:"sha256"`
	Databases []Database `json:"databases"`
}

// Reporter meldt het resultaat aan het panel.
type Reporter interface {
	ReportBackup(id int, ok bool, sha256 string, size int64, errMsg string)
	ReportRestore(id int, ok bool, errMsg string)
}

// ErrBusy: er loopt al een backup of herstel voor deze server.
var ErrBusy = errors.New("a backup or restore is already running for this server")

// Service voert backups en herstel uit.
type Service struct {
	Mgr     *server.Manager
	Rep     Reporter
	Log     *slog.Logger
	DBImage string
	// ProgressEvery is het interval van backup_progress (standaard 1 s).
	ProgressEvery time.Duration

	mu   sync.Mutex
	busy map[string]bool
	wg   sync.WaitGroup
}

// Wait wacht op lopende taken (tests).
func (s *Service) Wait() { s.wg.Wait() }

func (s *Service) lock(uuid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy == nil {
		s.busy = map[string]bool{}
	}
	if s.busy[uuid] {
		return false
	}
	s.busy[uuid] = true
	return true
}

func (s *Service) unlock(uuid string) {
	s.mu.Lock()
	delete(s.busy, uuid)
	s.mu.Unlock()
}

var (
	reDBName = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
	reSafe   = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,255}$`)
	reSHA    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// ValidateDatabases controleert de dumpgegevens (ze komen in een container-omgeving).
func ValidateDatabases(dbs []Database) error {
	for _, d := range dbs {
		if !reDBName.MatchString(d.Name) || !reSafe.MatchString(d.Host) || !reSafe.MatchString(d.Username) || d.Port < 1 || d.Port > 65535 {
			return fmt.Errorf("invalid database credentials for %q", d.Name)
		}
	}
	return nil
}

func (s *Service) progressEvery() time.Duration {
	if s.ProgressEvery > 0 {
		return s.ProgressEvery
	}
	return time.Second
}

func (s *Service) dbImage() string {
	if s.DBImage != "" {
		return s.DBImage
	}
	return DefaultDBImage
}

// StartBackup start een backup op de achtergrond; het resultaat gaat naar het panel.
func (s *Service) StartBackup(sv *server.Server, req BackupRequest) error {
	if !s.lock(sv.UUID()) {
		return ErrBusy
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.unlock(sv.UUID())
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
		defer cancel()
		sha, size, err := s.runBackup(ctx, sv, req)
		if err != nil {
			msg := scrub(err.Error(), req.S3, req.Databases)
			s.Log.Warn("backup failed", "uuid", sv.UUID(), "backup", req.BackupID, "err", msg)
			s.Rep.ReportBackup(req.BackupID, false, "", 0, msg)
			return
		}
		s.Rep.ReportBackup(req.BackupID, true, sha, size, "")
	}()
	return nil
}

// StartRestore start een herstel op de achtergrond.
func (s *Service) StartRestore(sv *server.Server, backupID int, req RestoreRequest) error {
	if !s.lock(sv.UUID()) {
		return ErrBusy
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.unlock(sv.UUID())
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
		defer cancel()
		err := s.runRestore(ctx, sv, backupID, req)
		if err != nil {
			msg := scrub(err.Error(), req.S3, req.Databases)
			s.Log.Warn("restore failed", "uuid", sv.UUID(), "backup", backupID, "err", msg)
			sv.DaemonMessage("error", "restore failed: "+msg)
			s.Rep.ReportRestore(backupID, false, msg)
			return
		}
		s.Rep.ReportRestore(backupID, true, "")
	}()
	return nil
}

// scrub haalt geheimen uit een foutmelding.
func scrub(msg string, s3 S3, dbs []Database) string {
	for _, secret := range append([]string{s3.SecretKey, s3.AccessKey}, passwords(dbs)...) {
		if len(secret) >= 4 {
			msg = strings.ReplaceAll(msg, secret, "***")
		}
	}
	if len(msg) > 1000 {
		msg = msg[:1000]
	}
	return msg
}

func passwords(dbs []Database) []string {
	var out []string
	for _, d := range dbs {
		out = append(out, d.Password)
	}
	return out
}

func (s *Service) tmpDir(pattern string) (string, error) {
	base := filepath.Join(s.Mgr.DataDir(), "tmp")
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", err
	}
	return os.MkdirTemp(base, pattern)
}

// ---------- backup ----------

func (s *Service) runBackup(ctx context.Context, sv *server.Server, req BackupRequest) (string, int64, error) {
	if !reSafe2.MatchString(req.Key) || strings.Contains(req.Key, "..") {
		return "", 0, errors.New("invalid S3 key")
	}
	if err := ValidateDatabases(req.Databases); err != nil {
		return "", 0, err
	}
	store, err := newStore(req.S3)
	if err != nil {
		return "", 0, err
	}
	var dumpDir string
	if len(req.Databases) > 0 {
		dumpDir, err = s.tmpDir("backup-" + sv.UUID() + "-")
		if err != nil {
			return "", 0, err
		}
		defer os.RemoveAll(dumpDir)
		uid, gid := s.Mgr.Owner()
		if err := os.Chown(dumpDir, uid, gid); err != nil {
			return "", 0, err
		}
		for _, db := range req.Databases {
			if err := s.dump(ctx, sv, db, dumpDir); err != nil {
				return "", 0, fmt.Errorf("dump of database %s: %w", db.Name, err)
			}
		}
	}
	vol := s.Mgr.Volume(sv.UUID())
	root, err := os.OpenRoot(vol)
	if err != nil {
		return "", 0, fmt.Errorf("opening server data: %w", err)
	}
	defer root.Close()
	ig := NewIgnore(req.Ignore)
	total := measure(ctx, root, ig)
	if dumpDir != "" {
		if ents, err := os.ReadDir(dumpDir); err == nil {
			for _, e := range ents {
				if info, err := e.Info(); err == nil {
					total += info.Size()
				}
			}
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	hasher := sha256.New()
	pr, pw := io.Pipe()
	var read atomic.Int64
	encDone := make(chan error, 1)
	go func() {
		err := compressTar(io.MultiWriter(hasher, pw), func(tw *tar.Writer) error {
			return writeTar(ctx, tw, root, ig, dumpDir, &read)
		})
		pw.CloseWithError(err) // nil = EOF
		encDone <- err
	}()
	stopProg := s.progress(ctx, sv, req.BackupID, &read, total)
	size, putErr := store.put(ctx, req.Key, pr)
	pr.CloseWithError(errors.New("upload ended")) // maakt de encoder los bij een fout
	encErr := <-encDone
	stopProg()
	if putErr != nil || encErr != nil {
		_ = store.remove(context.Background(), req.Key)
		if encErr != nil && !errors.Is(encErr, io.ErrClosedPipe) {
			return "", 0, fmt.Errorf("archiving: %w", encErr)
		}
		return "", 0, fmt.Errorf("upload: %w", putErr)
	}
	s.publish(sv, req.BackupID, read.Load(), 100)
	return hex.EncodeToString(hasher.Sum(nil)), size, nil
}

var reSafe2 = regexp.MustCompile(`^[A-Za-z0-9_./=+-]{1,512}$`)

func (s *Service) publish(sv *server.Server, id int, bytes int64, pct int) {
	sv.Publish(server.Msg{"event": "backup_progress", "backup_id": id, "bytes": bytes, "percent": pct})
}

// progress publiceert backup_progress tot de teruggegeven stop wordt aangeroepen.
func (s *Service) progress(ctx context.Context, sv *server.Server, id int, read *atomic.Int64, total int64) (stop func()) {
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
			case <-ctx.Done():
				return
			case <-t.C:
				n := read.Load()
				pct := 0
				if total > 0 {
					pct = int(n * 99 / total)
					if pct > 99 {
						pct = 99
					}
				}
				s.publish(sv, id, n, pct)
			}
		}
	}()
	return func() { close(done); wg.Wait() }
}

// ---------- databasetools ----------

// tool draait een tijdelijke container met de MariaDB-tools en geeft de exitcode en het
// laatste stuk van de uitvoer. dir wordt als /work gemount.
func (s *Service) tool(ctx context.Context, sv *server.Server, db Database, dir string, entrypoint []string, env []string) (string, error) {
	eng := s.Mgr.Engine()
	netw, err := s.Mgr.DBNetwork(ctx, sv, db.Host)
	if err != nil {
		return "", err
	}
	if err := eng.EnsureImage(ctx, s.dbImage(), nil); err != nil {
		return "", fmt.Errorf("image %s: %w", s.dbImage(), err)
	}
	uid, gid := s.Mgr.Owner()
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	name := "panel-" + sv.UUID() + "-dbtool-" + hex.EncodeToString(rnd[:])
	env = append(env, "MYSQL_PWD="+db.Password)
	id, err := eng.Create(ctx, engine.ContainerConfig{
		Name: name, Image: s.dbImage(), Entrypoint: entrypoint,
		Env: env, Labels: s.Mgr.TempLabels(sv.UUID()),
		User:        strconv.Itoa(uid) + ":" + strconv.Itoa(gid),
		Mounts:      []engine.Mount{{Source: dir, Target: "/work"}},
		CapDrop:     []string{"ALL"},
		SecurityOpt: []string{"no-new-privileges"},
		Resources:   engine.Resources{Memory: 512 << 20, MemorySwap: 512 << 20, PidsLimit: 128},
		NetworkMode: netw,
	})
	if err != nil {
		return "", err
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = eng.Remove(rctx, id)
	}()
	if err := eng.Start(ctx, id); err != nil {
		return "", err
	}
	code, err := eng.Wait(ctx, id)
	if err != nil {
		return "", err
	}
	if code != 0 {
		tail := ""
		if rc, err := eng.Logs(ctx, id, false); err == nil {
			b, _ := io.ReadAll(io.LimitReader(rc, 64<<10))
			rc.Close()
			tail = strings.TrimSpace(string(b))
			if len(tail) > 400 {
				tail = tail[len(tail)-400:]
			}
		}
		return "", fmt.Errorf("exit code %d: %s", code, scrub(tail, S3{}, []Database{db}))
	}
	return "", nil
}

func dbEnv(db Database) []string {
	return []string{"DB_HOST=" + db.Host, "DB_PORT=" + strconv.Itoa(db.Port), "DB_USER=" + db.Username, "DB_NAME=" + db.Name}
}

func (s *Service) dump(ctx context.Context, sv *server.Server, db Database, dir string) error {
	_, err := s.tool(ctx, sv, db, dir, []string{"/bin/sh", "-c",
		`exec mariadb-dump --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --single-transaction --skip-lock-tables --routines --events --result-file="/work/$DB_NAME.sql" "$DB_NAME"`},
		dbEnv(db))
	return err
}

func (s *Service) load(ctx context.Context, sv *server.Server, db Database, dir string) error {
	_, err := s.tool(ctx, sv, db, dir, []string{"/bin/sh", "-c",
		`exec mariadb --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" "$DB_NAME" < "/work/$DB_NAME.sql"`},
		dbEnv(db))
	return err
}

// ---------- herstel ----------

func (s *Service) runRestore(ctx context.Context, sv *server.Server, id int, req RestoreRequest) (err error) {
	if !reSafe2.MatchString(req.Key) || strings.Contains(req.Key, "..") || !reSHA.MatchString(req.SHA256) {
		return errors.New("invalid restore request")
	}
	if err := ValidateDatabases(req.Databases); err != nil {
		return err
	}
	store, err := newStore(req.S3)
	if err != nil {
		return err
	}
	uid, gid := s.Mgr.Owner()
	uuid := sv.UUID()
	vol := s.Mgr.Volume(uuid)
	parent := filepath.Dir(vol)

	// Stap 1: server stoppen en uit houden.
	wasRunning := sv.WasRunning()
	release, err := sv.HoldStopped()
	if err != nil {
		return fmt.Errorf("stopping server: %w", err)
	}
	defer func() {
		release()
		if wasRunning {
			sv.StartAfter() // ook na een mislukt herstel: de oude data is dan heel
		}
	}()
	s.publish(sv, id, 0, 0)

	// Stap 2+3: downloaden, checksum bijhouden en uitpakken naar een tijdelijke map naast de data.
	tmp, err := os.MkdirTemp(parent, ".restore-"+uuid+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp) // na een geslaagde swap bestaat hij niet meer
	dumpDir, err := s.tmpDir("restore-" + uuid + "-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dumpDir)
	if err := os.Chown(tmp, uid, gid); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o750); err != nil {
		return err
	}
	if err := os.Chown(dumpDir, uid, gid); err != nil {
		return err
	}
	if err := s.download(ctx, sv, id, store, req, tmp, dumpDir, uid, gid); err != nil {
		return err
	}

	// Stap 4: oude data opzij, nieuwe op zijn plek.
	old := ""
	if _, serr := os.Lstat(vol); serr == nil {
		old = filepath.Join(parent, ".old-"+uuid+"-"+strconv.FormatInt(time.Now().UnixNano(), 36))
		if err := os.Rename(vol, old); err != nil {
			return fmt.Errorf("moving old data aside: %w", err)
		}
	}
	if err := os.Rename(tmp, vol); err != nil {
		if old != "" {
			_ = os.Rename(old, vol)
		}
		return fmt.Errorf("moving restored data into place: %w", err)
	}
	for _, db := range req.Databases {
		if _, serr := os.Stat(filepath.Join(dumpDir, db.Name+".sql")); serr != nil {
			s.Log.Warn("database not in backup, skipped", "uuid", uuid, "db", db.Name)
			continue
		}
		if err := s.load(ctx, sv, db, dumpDir); err != nil {
			// Terugdraaien: de oude bestanden komen terug.
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
	// Stap 5: oude data weg.
	if old != "" {
		if err := os.RemoveAll(old); err != nil {
			s.Log.Warn("removing old data failed", "dir", old, "err", err)
		}
	}
	s.publish(sv, id, 0, 100)
	return nil
}

// download haalt het object op, pakt het uit en controleert de SHA-256 en de lengte.
// Pas als alles klopt geeft hij nil.
func (s *Service) download(ctx context.Context, sv *server.Server, id int, store *objectStore, req RestoreRequest, tmp, dumpDir string, uid, gid int) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	body, size, err := store.get(ctx, req.Key)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer body.Close()
	hasher := sha256.New()
	var got atomic.Int64
	tee := io.TeeReader(&countReader{r: body, n: &got}, hasher)
	dst, err := os.OpenRoot(tmp)
	if err != nil {
		return err
	}
	defer dst.Close()
	dumps, err := os.OpenRoot(dumpDir)
	if err != nil {
		return err
	}
	defer dumps.Close()

	done := make(chan struct{})
	go func() {
		t := time.NewTicker(s.progressEvery())
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				pct := 0
				if size > 0 {
					pct = int(got.Load() * 99 / size)
				}
				s.publish(sv, id, got.Load(), pct)
			}
		}
	}()
	defer close(done)

	if err := extract(ctx, tee, dst, dumps, uid, gid); err != nil {
		return fmt.Errorf("download/extract: %w", err)
	}
	if _, err := io.Copy(io.Discard, tee); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	if got.Load() != size {
		return fmt.Errorf("download incomplete: %d of %d bytes", got.Load(), size)
	}
	if hex.EncodeToString(hasher.Sum(nil)) != req.SHA256 {
		return errors.New("checksum mismatch: the backup is corrupt or was changed")
	}
	return nil
}
