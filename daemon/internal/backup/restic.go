package backup

// Incrementele backups met restic (zie docs/backups.md).
//
// Keuze: restic draait als kortlevende container (officiële image, vastgepind op versie en digest)
// en niet als meegeleverde binary. Zo blijft de daemon één statische binary zonder externe tools,
// draait restic zoals de database-tools met uid 1000, zonder capabilities, met een read-only
// rootfs en alleen de mounts die het nodig heeft (de serverdata read-only), en zit het op het
// eigen netwerk van de server (panel-site-<uuid>, uitgaand verkeer voor S3) in plaats van in
// het netwerk van de daemon. Containers krijgen de labels van een tijdelijke container
// (panel.role=install, panel.server_uuid) en heten panel-<uuid>-restic-<hex>.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"panel/daemon/internal/engine"
)

// DefaultResticImage is de vastgepinde restic-image (multi-arch index-digest van 0.18.1).
const DefaultResticImage = "restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76"

// Paden in de restic-container.
const (
	resticData    = "/home/container" // serverdata (read-only)
	resticDumps   = "/_databases"     // database-dumps (read-only)
	resticRestore = "/restore"        // doel van restic restore (schrijfbaar)
	resticCache   = "/cache"          // restic-cache per server (schrijfbaar, blijft bewaard)
	resticRepoDir = "/repo"           // alleen tests: lokale repository
	resticHost    = "panel"           // vaste hostnaam in snapshots: zo vindt restic de vorige snapshot als parent
)

// exit codes van restic (0.17+).
const (
	resticExitNoRepo = 10 // repository bestaat niet
	resticExitLocked = 11 // repository is vergrendeld
)

// Retention is het beleid voor restic forget (0 = die regel niet gebruiken).
type Retention struct {
	KeepLast   int `json:"keep_last"`
	KeepDaily  int `json:"keep_daily"`
	KeepWeekly int `json:"keep_weekly"`
}

func (r Retention) empty() bool { return r.KeepLast <= 0 && r.KeepDaily <= 0 && r.KeepWeekly <= 0 }

// ResticRepo zijn de gegevens om de repository van een server te openen. Ze leven alleen zolang
// het verzoek loopt; het wachtwoord komt nooit in logs.
type ResticRepo struct {
	S3       S3     `json:"s3"`
	Password string `json:"password"`
}

// ResticBackupRequest is ResticBackupRequest uit openapi.yaml.
type ResticBackupRequest struct {
	ResticRepo
	BackupID  int        `json:"backup_id"`
	Ignore    []string   `json:"ignore"`
	Databases []Database `json:"databases"`
	Retention *Retention `json:"retention"`
	Prune     bool       `json:"prune"`
}

// ResticRestoreRequest is ResticRestoreRequest uit openapi.yaml. Zonder Paths: de hele snapshot
// (server stoppen en data omwisselen); met Paths: alleen die paden, naar hun plek of naar Destination.
type ResticRestoreRequest struct {
	ResticRepo
	SnapshotID  string     `json:"snapshot_id"`
	Databases   []Database `json:"databases"`
	Paths       []string   `json:"paths"`
	Destination string     `json:"destination"`
}

// ResticLsRequest is ResticLsRequest uit openapi.yaml.
type ResticLsRequest struct {
	ResticRepo
	SnapshotID string `json:"snapshot_id"`
	Path       string `json:"path"`
}

// ResticForgetRequest is ResticForgetRequest uit openapi.yaml.
type ResticForgetRequest struct {
	ResticRepo
	SnapshotIDs []string `json:"snapshot_ids"`
}

// SnapshotResult is wat het panel na een geslaagde incrementele backup krijgt.
type SnapshotResult struct {
	SnapshotID string   `json:"snapshot_id"`
	TotalBytes int64    `json:"size_bytes"`  // grootte van de snapshot (verwerkte brondata)
	AddedBytes int64    `json:"added_bytes"` // nieuw in de repository (gecomprimeerd)
	Forgotten  []string `json:"forgotten_snapshots"`
	Pruned     bool     `json:"pruned"`
}

// LsEntry is één item uit restic ls (pad relatief aan /home/container).
type LsEntry struct {
	Name  string    `json:"name"`
	Path  string    `json:"path"`
	Type  string    `json:"type"` // file | dir | symlink | other
	Size  int64     `json:"size"`
	MTime time.Time `json:"mtime"`
}

// MaxLsEntries begrenst het aantal items per map in restic ls.
const MaxLsEntries = 5000

// MaxRestorePaths begrenst het aantal paden per gedeeltelijk herstel.
const MaxRestorePaths = 100

var (
	reSnapshot = regexp.MustCompile(`^[a-f0-9]{8,64}$`)
	reBucket   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,255}$`)
	reUUID     = regexp.MustCompile(`^[a-f0-9-]{36}$`)
)

// ValidSnapshotID meldt of id een restic-snapshot-id (kort of lang) is.
func ValidSnapshotID(id string) bool { return reSnapshot.MatchString(id) }

// Validate controleert de repository-gegevens.
func (r ResticRepo) Validate() error {
	if len(r.Password) < 16 || len(r.Password) > 1024 || strings.ContainsAny(r.Password, "\x00\r\n") {
		return errors.New("invalid repository password")
	}
	if r.S3.Endpoint == "" || !reBucket.MatchString(r.S3.Bucket) {
		return errors.New("invalid S3 target")
	}
	return nil
}

// RepoURL is de restic-repository van een server: s3:<endpoint>/<bucket>/restic/<uuid>.
func RepoURL(c S3, uuid string) (string, error) {
	if !reUUID.MatchString(uuid) || !reBucket.MatchString(c.Bucket) {
		return "", errors.New("invalid repository")
	}
	ep := strings.TrimRight(strings.TrimSpace(c.Endpoint), "/")
	if !strings.Contains(ep, "://") {
		ep = "https://" + ep
	}
	if !strings.HasPrefix(ep, "https://") && !strings.HasPrefix(ep, "http://") {
		return "", errors.New("invalid S3 endpoint")
	}
	rest := ep[strings.Index(ep, "://")+3:]
	if rest == "" || strings.ContainsAny(rest, "/?#@ ") {
		return "", errors.New("invalid S3 endpoint")
	}
	return "s3:" + ep + "/" + c.Bucket + "/restic/" + uuid, nil
}

// CleanRel maakt een pad uit een verzoek relatief aan /home/container en weigert alles wat
// erbuiten kan komen. "" en "/" worden ".".
func CleanRel(p string) (string, error) {
	if len(p) > 4096 || strings.ContainsAny(p, "\x00\r\n") || strings.Contains(p, "\\") {
		return "", errors.New("invalid path")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return "", errors.New("invalid path")
		}
	}
	c := path.Clean("/" + p)
	if c == "/" {
		return ".", nil
	}
	return strings.TrimPrefix(c, "/"), nil
}

// globEscape maakt van een pad een restic-patroon dat alleen dat pad raakt.
func globEscape(p string) string {
	var b strings.Builder
	for _, r := range p {
		switch r {
		case '*', '?', '[', ']', '\\':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// excludeArgs zet ignore-patronen (relatief aan de serverroot, zie Ignore) om naar restic --exclude.
// Een patroon met / vooraan geldt vanaf de root; zonder / overal (zoals bij restic zelf).
func excludeArgs(patterns []string) []string {
	var out []string
	for _, p := range patterns {
		p = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(p), "./"))
		if p == "" || strings.ContainsAny(p, "\x00\r\n") {
			continue
		}
		anchored := strings.HasPrefix(p, "/")
		p = strings.Trim(p, "/")
		if p == "" {
			continue
		}
		if anchored || strings.Contains(p, "/") {
			p = resticData + "/" + p
		}
		out = append(out, "--exclude", p)
	}
	return out
}

// backupArgs is het restic-commando voor een backup.
func backupArgs(id int, ignore []string, withDumps bool) []string {
	args := []string{"backup", "--json", "--host", resticHost, "--tag", "panel-backup-" + strconv.Itoa(id), "--exclude", resticData + "/" + DumpDir}
	args = append(args, excludeArgs(ignore)...)
	args = append(args, resticData)
	if withDumps {
		args = append(args, resticDumps)
	}
	return args
}

// forgetArgs is het restic-commando voor het retentiebeleid. Alle snapshots in één groep: de
// repository is van één server.
func forgetArgs(r Retention, prune bool) []string {
	args := []string{"forget", "--json", "--group-by", ""}
	if r.KeepLast > 0 {
		args = append(args, "--keep-last", strconv.Itoa(r.KeepLast))
	}
	if r.KeepDaily > 0 {
		args = append(args, "--keep-daily", strconv.Itoa(r.KeepDaily))
	}
	if r.KeepWeekly > 0 {
		args = append(args, "--keep-weekly", strconv.Itoa(r.KeepWeekly))
	}
	if prune {
		args = append(args, "--prune")
	}
	return args
}

// restoreArgs is het restic-commando voor een herstel naar /restore; paths (relatief) beperken het.
func restoreArgs(snapshot string, paths []string) []string {
	args := []string{"restore", snapshot, "--json", "--target", resticRestore}
	for _, p := range paths {
		args = append(args, "--include", globEscape(resticData+"/"+p))
	}
	return args
}

// lsArgs is restic ls van één map (niet recursief), zonder lock.
func lsArgs(snapshot, rel string) []string {
	dir := resticData
	if rel != "." {
		dir += "/" + rel
	}
	return []string{"ls", "--json", "--no-lock", snapshot, dir}
}

// resticSpec is alles wat nodig is om de restic-container te maken.
type resticSpec struct {
	UUID      string
	Image     string
	Repo      ResticRepo
	LocalRepo string // tests: hostmap als repository in plaats van S3
	Args      []string
	Mounts    []engine.Mount
	Cache     string // hostmap voor RESTIC_CACHE_DIR
	Network   string
	UID, GID  int
	Labels    map[string]string
}

// resticContainer bouwt de containerconfig. Geheimen staan alleen in de omgeving.
func resticContainer(sp resticSpec) (engine.ContainerConfig, error) {
	env := []string{"RESTIC_PASSWORD=" + sp.Repo.Password, "RESTIC_CACHE_DIR=" + resticCache, "RESTIC_PROGRESS_FPS=1", "HOME=/tmp", "TZ=Europe/Amsterdam"}
	global := []string{"--retry-lock", "1m"}
	mounts := append([]engine.Mount{}, sp.Mounts...)
	if sp.Cache != "" {
		mounts = append(mounts, engine.Mount{Source: sp.Cache, Target: resticCache})
	}
	if sp.LocalRepo != "" {
		env = append(env, "RESTIC_REPOSITORY="+resticRepoDir)
		mounts = append(mounts, engine.Mount{Source: sp.LocalRepo, Target: resticRepoDir})
	} else {
		repo, err := RepoURL(sp.Repo.S3, sp.UUID)
		if err != nil {
			return engine.ContainerConfig{}, err
		}
		region := sp.Repo.S3.Region
		if region == "" {
			region = "us-east-1"
		}
		env = append(env, "RESTIC_REPOSITORY="+repo, "AWS_ACCESS_KEY_ID="+sp.Repo.S3.AccessKey, "AWS_SECRET_ACCESS_KEY="+sp.Repo.S3.SecretKey, "AWS_DEFAULT_REGION="+region)
		lookup := "dns"
		if sp.Repo.S3.PathStyle {
			lookup = "path"
		}
		global = append(global, "-o", "s3.bucket-lookup="+lookup, "-o", "s3.region="+region)
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	return engine.ContainerConfig{
		Name:           "panel-" + sp.UUID + "-restic-" + hex.EncodeToString(rnd[:]),
		Image:          sp.Image,
		Entrypoint:     []string{"/usr/bin/restic"},
		Cmd:            append(global, sp.Args...),
		Env:            env,
		Labels:         sp.Labels,
		User:           strconv.Itoa(sp.UID) + ":" + strconv.Itoa(sp.GID),
		Mounts:         mounts,
		ReadOnlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,nosuid,nodev,size=64m"},
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		Resources:      engine.Resources{Memory: 1 << 30, MemorySwap: 1 << 30, PidsLimit: 256},
		NetworkMode:    sp.Network,
	}, nil
}

// ResticError is een mislukte restic-aanroep.
type ResticError struct {
	Code int
	Msg  string
}

func (e *ResticError) Error() string { return fmt.Sprintf("restic exit code %d: %s", e.Code, e.Msg) }

func resticCode(err error) int {
	var re *ResticError
	if errors.As(err, &re) {
		return re.Code
	}
	return -1
}

// resticMsg is een JSON-regel van restic (alle soorten; alleen de velden die we gebruiken).
type resticMsg struct {
	MessageType string `json:"message_type"`
	// status (backup/restore)
	PercentDone   float64 `json:"percent_done"`
	TotalBytes    int64   `json:"total_bytes"`
	BytesDone     int64   `json:"bytes_done"`
	BytesRestored int64   `json:"bytes_restored"`
	// summary (backup)
	SnapshotID          string `json:"snapshot_id"`
	DataAddedPacked     int64  `json:"data_added_packed"`
	DataAdded           int64  `json:"data_added"`
	TotalBytesProcessed int64  `json:"total_bytes_processed"`
	// error / exit_error
	Message string `json:"message"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item string `json:"item"`
	// ls (node)
	StructType string    `json:"struct_type"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	MTime      time.Time `json:"mtime"`
}

// lineCollector verwerkt de uitvoer van restic regel voor regel: JSON naar fn, de rest (stderr)
// als staart voor de foutmelding.
type lineCollector struct {
	fn   func(resticMsg)
	tail []string
}

func (c *lineCollector) line(b []byte) {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return
	}
	if b[0] == '{' {
		var m resticMsg
		if json.Unmarshal(b, &m) == nil {
			switch m.MessageType {
			case "exit_error":
				c.keep(m.Message)
			case "error":
				if m.Error != nil {
					c.keep(strings.TrimSpace(m.Item + ": " + m.Error.Message))
				}
			}
			if c.fn != nil {
				c.fn(m)
			}
			return
		}
	}
	if b[0] == '[' && json.Valid(b) { // forget/snapshots: één JSON-array (niet de "[0:00] 100%"-regels van prune)
		if c.fn != nil {
			c.fn(resticMsg{MessageType: "array", Message: string(b)})
		}
		return
	}
	c.keep(string(b))
}

func (c *lineCollector) keep(s string) {
	if s == "" {
		return
	}
	c.tail = append(c.tail, s)
	if len(c.tail) > 8 {
		c.tail = c.tail[len(c.tail)-8:]
	}
}

func (c *lineCollector) read(r io.Reader) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	for sc.Scan() {
		c.line(sc.Bytes())
	}
	return sc.Err()
}

func (c *lineCollector) message() string {
	s := strings.Join(c.tail, "; ")
	if len(s) > 600 {
		s = s[len(s)-600:]
	}
	return s
}

// forgotten haalt de verwijderde snapshot-id's uit de JSON van restic forget.
func forgotten(raw string) ([]string, error) {
	var groups []struct {
		Remove []struct {
			ID string `json:"id"`
		} `json:"remove"`
	}
	if err := json.Unmarshal([]byte(raw), &groups); err != nil {
		return nil, err
	}
	out := []string{}
	for _, g := range groups {
		for _, s := range g.Remove {
			out = append(out, s.ID)
		}
	}
	return out, nil
}

// lsEntry zet een node uit restic ls om; ok=false voor de map zelf of iets buiten dir.
func lsEntry(m resticMsg, dir string) (LsEntry, bool) {
	if m.StructType != "node" && m.MessageType != "node" {
		return LsEntry{}, false
	}
	if m.Path == dir || !strings.HasPrefix(m.Path, dir+"/") || strings.Contains(m.Path[len(dir)+1:], "/") {
		return LsEntry{}, false
	}
	t := m.Type
	if t != "file" && t != "dir" && t != "symlink" {
		t = "other"
	}
	rel := strings.TrimPrefix(m.Path, resticData+"/")
	return LsEntry{Name: m.Name, Path: rel, Type: t, Size: m.Size, MTime: m.MTime}, true
}

func scrubRepo(msg string, r ResticRepo, dbs []Database) string {
	if len(r.Password) >= 4 {
		msg = strings.ReplaceAll(msg, r.Password, "***")
	}
	return scrub(msg, r.S3, dbs)
}

// runRestic draait één restic-commando in een tijdelijke container en geeft elke JSON-regel aan fn.
func (s *Service) runRestic(ctx context.Context, sp resticSpec, fn func(resticMsg)) error {
	eng := s.Mgr.Engine()
	if err := eng.EnsureImage(ctx, sp.Image, nil); err != nil {
		return fmt.Errorf("image %s: %w", sp.Image, err)
	}
	cfg, err := resticContainer(sp)
	if err != nil {
		return err
	}
	id, err := eng.Create(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = eng.Remove(rctx, id)
	}()
	if err := eng.Start(ctx, id); err != nil {
		return err
	}
	col := &lineCollector{fn: fn}
	if rc, err := eng.Logs(ctx, id, true); err == nil {
		_ = col.read(rc)
		rc.Close()
	}
	code, err := eng.Wait(ctx, id)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if code != 0 {
		return &ResticError{Code: code, Msg: scrubRepo(col.message(), sp.Repo, nil)}
	}
	return nil
}
