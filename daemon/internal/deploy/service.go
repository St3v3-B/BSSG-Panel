// Package deploy voert git-deploys van websites uit (POST /api/servers/{uuid}/deploy).
//
// Verloop (alles in tijdelijke containers met panel.role=install, uid 1000, zonder capabilities,
// op het eigen netwerk van de site en met de limieten van de server):
//
//  1. git: fetch --depth 1 van de branch in een cache-repo buiten de serverdata
//     ($DATA_DIR/deploy/<uuid>/repo.git, dus onbereikbaar voor de site zelf) en git archive naar
//     $DATA_DIR/deploy/<uuid>/release.tar. Alleen deze container krijgt het token of de
//     SSH-sleutel (in de omgeving), en hij ziet de serverdata niet.
//  2. build: pakt het archief uit in .panel-deploy/release-<id> binnen de serverdata en draait
//     het build-commando (optioneel) in de gekozen image. Geen geheimen.
//  3. publish (in de daemon, via files.Root dus nooit buiten de serverdata): gedeelde paden uit
//     de huidige doelmap overnemen en de doelmap atomisch omwisselen (RENAME_EXCHANGE).
//
// Faalt of stopt iets vóór stap 3, dan is de doelmap niet aangeraakt.
package deploy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/files"
	"panel/daemon/internal/server"
)

// DefaultGitImage bevat git, openssh-client en tar.
const DefaultGitImage = "alpine/git:v2.49.1"

// Auth is DeployAuth uit openapi.yaml.
type Auth struct {
	Type       string `json:"type"`
	Username   string `json:"username,omitempty"`
	Token      string `json:"token,omitempty"`
	PrivateKey string `json:"private_key,omitempty"`
	KnownHosts string `json:"known_hosts,omitempty"`
}

// String houdt geheimen uit logs.
func (a Auth) String() string { return "Auth{" + a.Type + "}" }

// Build is het optionele build-commando.
type Build struct {
	Command string `json:"command"`
	Image   string `json:"image"`
}

// Request is DeployRequest uit openapi.yaml.
type Request struct {
	DeployID       int      `json:"deploy_id"`
	RepoURL        string   `json:"repo_url"`
	Branch         string   `json:"branch"`
	Auth           Auth     `json:"auth"`
	TargetDir      string   `json:"target_dir"`
	SourceDir      string   `json:"source_dir"`
	SharedPaths    []string `json:"shared_paths"`
	Build          *Build   `json:"build"`
	Restart        bool     `json:"restart"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
	LogLines       int      `json:"log_lines,omitempty"`
}

// Commit is DeployCommit uit openapi.yaml.
type Commit struct {
	SHA     string     `json:"sha"`
	Author  string     `json:"author"`
	Message string     `json:"message"`
	Date    *time.Time `json:"date"`
}

// Progress is DeployProgress uit openapi.yaml.
type Progress struct {
	DeployID    int       `json:"deploy_id"`
	Phase       string    `json:"phase"`
	StartedAt   time.Time `json:"started_at"`
	Cancellable bool      `json:"cancellable"`
	Log         []string  `json:"log"`
	Commit      *Commit   `json:"commit"`
}

// Result gaat naar POST /api/remote/deploys/{id}.
type Result struct {
	Status     string   `json:"status"` // succeeded, failed, cancelled
	Error      *string  `json:"error"`
	Commit     *Commit  `json:"commit"`
	LogTail    []string `json:"log_tail"`
	DurationMS int64    `json:"duration_ms"`
}

// Reporter meldt het resultaat aan het panel.
type Reporter interface {
	ReportDeploy(id int, r Result)
}

// Fouten voor de API.
var (
	ErrBusy           = errors.New("a deploy is already running for this site")
	ErrNotRunning     = errors.New("this deploy is not running")
	ErrNotCancellable = errors.New("the deploy is already swapping folders")
	ErrNotWeb         = errors.New("git deploy is only available for websites")
)

// Service voert deploys uit.
type Service struct {
	Mgr *server.Manager
	Rep Reporter
	Log *slog.Logger
	// GitImage: standaard DefaultGitImage.
	GitImage string
	// AllowHTTP staat http:// toe (alleen tests).
	AllowHTTP bool

	mu   sync.Mutex
	jobs map[string]*job
	wg   sync.WaitGroup
}

type job struct {
	req     Request
	started time.Time
	cancel  context.CancelFunc
	log     *ring
	red     *Redactor

	mu        sync.Mutex
	phase     string
	cancelled bool
	commit    *Commit
}

func (j *job) setPhase(p string) {
	j.mu.Lock()
	j.phase = p
	j.mu.Unlock()
}

func (j *job) line(s string) { j.log.add(j.red.Line(s)) }

// Wait wacht op lopende deploys (tests).
func (s *Service) Wait() { s.wg.Wait() }

func (s *Service) gitImage() string {
	if s.GitImage != "" {
		return s.GitImage
	}
	return DefaultGitImage
}

func gitName(uuid string) string   { return "panel-" + uuid + "-deploy-git" }
func buildName(uuid string) string { return "panel-" + uuid + "-deploy-build" }

// Cleanup verwijdert deploy-containers die een daemon-herstart overleefden.
func (s *Service) Cleanup(ctx context.Context) {
	eng := s.Mgr.Engine()
	l := s.Mgr.BaseLabels()
	l[server.LabelRole] = server.RoleInstall
	list, err := eng.List(ctx, l)
	if err != nil {
		return
	}
	for _, c := range list {
		uuid := c.Labels[server.LabelUUID]
		if uuid == "" || (c.Name != gitName(uuid) && c.Name != buildName(uuid)) {
			continue
		}
		if err := eng.Remove(ctx, c.ID); err != nil && !errors.Is(err, engine.ErrNotFound) {
			s.Log.Warn("removing stale deploy container failed", "container", c.Name, "err", err)
		}
	}
}

// Start valideert en start een deploy op de achtergrond.
func (s *Service) Start(sv *server.Server, req Request) error {
	if !sv.IsWeb() {
		return ErrNotWeb
	}
	rem, err := req.Validate(s.AllowHTTP)
	if err != nil {
		return &BadRequest{err}
	}
	_ = rem
	s.mu.Lock()
	if s.jobs == nil {
		s.jobs = map[string]*job{}
	}
	if _, busy := s.jobs[sv.UUID()]; busy {
		s.mu.Unlock()
		return ErrBusy
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.TimeoutSeconds)*time.Second)
	j := &job{req: req, started: time.Now().UTC(), cancel: cancel, log: newRing(500), phase: "fetching",
		red: NewRedactor(req.Auth.Username, req.Auth.Token, req.Auth.PrivateKey)}
	s.jobs[sv.UUID()] = j
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		defer cancel()
		s.run(ctx, sv, j)
	}()
	return nil
}

// BadRequest is een validatiefout (400).
type BadRequest struct{ Err error }

func (b *BadRequest) Error() string { return b.Err.Error() }
func (b *BadRequest) Unwrap() error { return b.Err }

// Progress geeft de lopende deploy van een server.
func (s *Service) Progress(uuid string) (Progress, bool) {
	s.mu.Lock()
	j := s.jobs[uuid]
	s.mu.Unlock()
	if j == nil {
		return Progress{}, false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return Progress{DeployID: j.req.DeployID, Phase: j.phase, StartedAt: j.started, Cancellable: j.phase != "publishing", Log: j.log.tail(0), Commit: j.commit}, true
}

// Busy meldt of er voor deze server een deploy loopt.
func (s *Service) Busy(uuid string) bool {
	_, ok := s.Progress(uuid)
	return ok
}

// Cancel breekt een lopende deploy af (alleen vóór het omwisselen).
func (s *Service) Cancel(uuid string, id int) error {
	s.mu.Lock()
	j := s.jobs[uuid]
	s.mu.Unlock()
	if j == nil || j.req.DeployID != id {
		return ErrNotRunning
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.phase == "publishing" {
		return ErrNotCancellable
	}
	j.cancelled = true
	j.cancel()
	return nil
}

func (s *Service) cacheDir(uuid string) string {
	return filepath.Join(s.Mgr.DataDir(), "deploy", uuid)
}

// ForgetServer verwijdert de cache van een server (na het verwijderen ervan).
func (s *Service) ForgetServer(uuid string) {
	_ = os.RemoveAll(s.cacheDir(uuid))
}

func (s *Service) run(ctx context.Context, sv *server.Server, j *job) {
	uuid := sv.UUID()
	sv.DaemonMessage("info", fmt.Sprintf("Deploy #%d started (%s)", j.req.DeployID, j.req.Branch))
	err := s.execute(ctx, sv, j)
	res := Result{Status: "succeeded", LogTail: nil}
	j.mu.Lock()
	cancelled := j.cancelled
	res.Commit = j.commit
	j.mu.Unlock()
	switch {
	case err == nil:
		j.line("Deploy finished.")
		sv.DaemonMessage("info", fmt.Sprintf("Deploy #%d finished", j.req.DeployID))
	case cancelled:
		res.Status = "cancelled"
		msg := "cancelled"
		res.Error = &msg
		j.line("Deploy cancelled; the previous version is still live.")
		sv.DaemonMessage("warning", fmt.Sprintf("Deploy #%d cancelled", j.req.DeployID))
	default:
		res.Status = "failed"
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("timed out after %ds", j.req.TimeoutSeconds)
		}
		msg := j.red.Line(err.Error())
		res.Error = &msg
		j.line("Deploy failed: " + msg)
		sv.DaemonMessage("error", fmt.Sprintf("Deploy #%d failed: %s", j.req.DeployID, msg))
	}
	res.DurationMS = time.Since(j.started).Milliseconds()
	res.LogTail = j.log.tail(j.req.LogLines)
	s.mu.Lock()
	delete(s.jobs, uuid)
	s.mu.Unlock()
	if s.Rep != nil {
		s.Rep.ReportDeploy(j.req.DeployID, res)
	}
	if err == nil && j.req.Restart {
		if st := sv.State(); st == server.StateOnline || st == server.StateStarting {
			if perr := sv.Power("restart"); perr != nil {
				s.Log.Warn("restart after deploy failed", "uuid", uuid, "err", perr)
			}
		}
	}
	sv.RemeasureDisk()
}

const passwd = "root:x:0:0:root:/root:/bin/sh\ndeploy:x:1000:1000:deploy:/tmp:/bin/sh\nnobody:x:65534:65534:nobody:/:/sbin/nologin\n"

func (s *Service) prepareCache(uuid, repoURL string) (string, string, error) {
	base := filepath.Join(s.Mgr.DataDir(), "deploy")
	if err := os.MkdirAll(base, 0o711); err != nil {
		return "", "", err
	}
	pw := filepath.Join(base, "passwd")
	if b, err := os.ReadFile(pw); err != nil || string(b) != passwd {
		if err := os.WriteFile(pw, []byte(passwd), 0o644); err != nil {
			return "", "", err
		}
	}
	dir := s.cacheDir(uuid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	uid, gid := s.Mgr.Owner()
	if err := os.Lchown(dir, uid, gid); err != nil {
		return "", "", err
	}
	// Andere repository: cache weggooien (schoon begin, geen objecten van een vorige bron).
	urlFile := filepath.Join(base, uuid+".url")
	if b, _ := os.ReadFile(urlFile); string(b) != repoURL {
		_ = os.RemoveAll(filepath.Join(dir, "repo.git"))
		if err := os.WriteFile(urlFile, []byte(repoURL), 0o600); err != nil {
			return "", "", err
		}
	}
	_ = os.Remove(filepath.Join(dir, "release.tar"))
	return dir, pw, nil
}

func (s *Service) execute(ctx context.Context, sv *server.Server, j *job) error {
	uuid := sv.UUID()
	root := sv.Root()
	cache, pw, err := s.prepareCache(uuid, j.req.RepoURL)
	if err != nil {
		return fmt.Errorf("deploy cache: %w", err)
	}
	defer os.Remove(filepath.Join(cache, "release.tar"))
	// Werkmap in de serverdata; resten van een eerdere (afgebroken) deploy opruimen.
	if k, err := kind(root, stageDir); err != nil {
		return err
	} else if k == "other" {
		if err := root.RemoveAll(files.APIPath(stageDir)); err != nil {
			return err
		}
	}
	if err := root.MkdirAll(stageDir); err != nil {
		return fmt.Errorf("work folder: %w", err)
	}
	if entries, err := root.List(files.APIPath(stageDir)); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name, "release-") {
				_ = root.RemoveAll(files.APIPath(stageDir + "/" + e.Name))
			}
		}
	}
	rel := stageDir + "/release-" + strconv.Itoa(j.req.DeployID)
	defer func() {
		if err := root.RemoveAll(files.APIPath(rel)); err != nil {
			s.Log.Warn("removing deploy release folder failed", "uuid", uuid, "err", err)
		}
	}()
	if err := s.Mgr.EnsureServerNetwork(ctx, uuid); err != nil {
		return fmt.Errorf("site network: %w", err)
	}

	// 1. git
	j.line(fmt.Sprintf("Fetching %s (branch %s)", j.req.RepoURL, j.req.Branch))
	if err := s.Mgr.EnsureImage(ctx, s.gitImage(), j.line); err != nil {
		return fmt.Errorf("image %s: %w", s.gitImage(), err)
	}
	var commitLine string
	code, err := s.runContainer(ctx, j, s.gitConfig(sv, j, cache, pw), func(l string) {
		if c, ok := strings.CutPrefix(l, "::commit::"); ok {
			commitLine = c
			return
		}
		j.line(l)
	})
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("git exited with code %d", code)
	}
	if c := parseCommit(commitLine); c != nil {
		j.mu.Lock()
		j.commit = c
		j.mu.Unlock()
		j.line(fmt.Sprintf("Commit %s by %s: %s", short(c.SHA), c.Author, c.Message))
	}
	fi, err := os.Stat(filepath.Join(cache, "release.tar"))
	if err != nil {
		return errors.New("git did not produce an archive")
	}
	if lim := int64(sv.Spec().Limits.DiskMB) * 1024 * 1024; lim > 0 && fi.Size() > lim {
		return fmt.Errorf("the repository (%d MB) is larger than the disk limit of the site", fi.Size()>>20)
	}

	// 2. uitpakken + build
	img := s.gitImage()
	if j.req.Build != nil {
		j.setPhase("building")
		img = j.req.Build.Image
		if err := s.Mgr.EnsureImage(ctx, img, j.line); err != nil {
			return fmt.Errorf("image %s: %w", img, err)
		}
	}
	code, err = s.runContainer(ctx, j, s.buildConfig(sv, j, img, cache), j.line)
	if err != nil {
		return err
	}
	if code != 0 {
		if j.req.Build != nil {
			return fmt.Errorf("build command exited with code %d", code)
		}
		return fmt.Errorf("unpacking exited with code %d", code)
	}

	// 3. omwisselen
	j.mu.Lock()
	if ctx.Err() != nil {
		j.mu.Unlock()
		return ctx.Err()
	}
	j.phase = "publishing"
	j.mu.Unlock()
	j.line("Publishing to " + files.APIPath(j.req.TargetDir))
	src := join(rel, j.req.SourceDir)
	if err := publish(root, src, j.req.TargetDir, j.req.SharedPaths, j.line); err != nil {
		return err
	}
	return nil
}

func short(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

func parseCommit(l string) *Commit {
	p := strings.SplitN(l, "\x1f", 4)
	if len(p) != 4 || len(p[0]) < 7 {
		return nil
	}
	c := &Commit{SHA: p[0], Author: trunc(p[1], 200), Message: trunc(p[3], 500)}
	if t, err := time.Parse(time.RFC3339, p[2]); err == nil {
		t = t.UTC()
		c.Date = &t
	}
	return c
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// runContainer start een tijdelijke container, stuurt zijn uitvoer per regel naar line en
// wacht tot hij klaar is. Bij een afgebroken ctx wordt hij gekild. De container wordt altijd
// verwijderd.
func (s *Service) runContainer(ctx context.Context, j *job, cfg engine.ContainerConfig, line func(string)) (int, error) {
	eng := s.Mgr.Engine()
	if err := eng.Remove(context.Background(), cfg.Name); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return 0, err
	}
	id, err := eng.Create(ctx, cfg)
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, fmt.Errorf("creating container: %w", err)
	}
	defer func() { _ = eng.Remove(context.Background(), id) }()
	if err := eng.Start(ctx, id); err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, fmt.Errorf("starting container: %w", err)
	}
	logsDone := make(chan struct{})
	go func() {
		defer close(logsDone)
		rc, err := eng.Logs(context.Background(), id, true)
		if err != nil {
			return
		}
		defer rc.Close()
		server.ReadLines(rc, line)
	}()
	code, err := eng.Wait(ctx, id)
	if ctx.Err() != nil {
		_ = eng.Kill(context.Background(), id, "SIGKILL")
		return 0, ctx.Err()
	}
	select {
	case <-logsDone:
	case <-time.After(5 * time.Second):
	}
	if err != nil {
		return 0, err
	}
	return code, nil
}

// gitEnv is de git-configuratie via de omgeving (command-scope: gaat boven alles uit de repo).
func (s *Service) gitEnv(j *job) []string {
	cfg := [][2]string{
		{"core.hooksPath", "/dev/null"},
		{"core.fsmonitor", "false"},
		{"protocol.allow", "never"},
		{"protocol.https.allow", "always"},
		{"protocol.ssh.allow", "always"},
		{"credential.helper", ""},
		{"http.followRedirects", "initial"},
		{"advice.detachedHead", "false"},
		{"init.defaultBranch", "main"},
		{"safe.directory", "*"},
	}
	allow := "https:ssh"
	if s.AllowHTTP {
		cfg = append(cfg, [2]string{"protocol.http.allow", "always"})
		allow += ":http"
	}
	env := []string{
		"HOME=/tmp", "TZ=Europe/Amsterdam", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/false", "SSH_ASKPASS=/bin/false",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_ALLOW_PROTOCOL=" + allow,
		"DEPLOY_REPO=" + j.req.RepoURL, "DEPLOY_BRANCH=" + j.req.Branch,
	}
	switch j.req.Auth.Type {
	case "token":
		cfg = append(cfg, [2]string{"credential.helper", `!f() { test "$1" = get || exit 0; printf 'username=%s\npassword=%s\n' "$DEPLOY_USER" "$DEPLOY_TOKEN"; }; f`})
		env = append(env, "DEPLOY_USER="+j.req.Auth.Username, "DEPLOY_TOKEN="+j.req.Auth.Token)
	case "ssh":
		env = append(env, "DEPLOY_SSH_KEY="+strings.TrimSpace(j.req.Auth.PrivateKey), "DEPLOY_KNOWN_HOSTS="+j.req.Auth.KnownHosts)
	}
	env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(len(cfg)))
	for i, kv := range cfg {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, kv[1]))
	}
	return env
}

const gitScript = `set -eu
umask 022
if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$DEPLOY_SSH_KEY" > /tmp/id
  printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > /tmp/known_hosts
  umask 022
  unset DEPLOY_SSH_KEY
  export GIT_SSH_COMMAND="ssh -F /dev/null -i /tmp/id -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=/tmp/known_hosts -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"
fi
G="git --git-dir=/cache/repo.git"
[ -f /cache/repo.git/HEAD ] || git init -q --bare /cache/repo.git
$G fetch --depth=1 --no-tags --force --no-write-fetch-head -- "$DEPLOY_REPO" "+refs/heads/$DEPLOY_BRANCH:refs/panel/deploy"
$G log -1 --format='::commit::%H%x1f%an%x1f%aI%x1f%s' refs/panel/deploy
$G archive --format=tar -o /cache/release.tar refs/panel/deploy
$G gc --auto --quiet >/dev/null 2>&1 || true
echo "Fetched."
`

func (s *Service) limits(sv *server.Server) engine.Resources {
	r := server.Resources(sv.Spec().Limits)
	const floor = 256 * 1024 * 1024
	if r.Memory > 0 && r.Memory < floor {
		r.Memory = floor
		if r.MemorySwap >= 0 && r.MemorySwap < floor {
			r.MemorySwap = floor
		}
	}
	return r
}

func (s *Service) labels(uuid string, id int) map[string]string {
	l := s.Mgr.TempLabels(uuid)
	l["panel.deploy_id"] = strconv.Itoa(id)
	return l
}

func (s *Service) gitConfig(sv *server.Server, j *job, cache, passwdFile string) engine.ContainerConfig {
	uid, gid := s.Mgr.Owner()
	return engine.ContainerConfig{
		Name:           gitName(sv.UUID()),
		Image:          s.gitImage(),
		Entrypoint:     []string{"/bin/sh", "-c"},
		Cmd:            []string{gitScript},
		Env:            s.gitEnv(j),
		Labels:         s.labels(sv.UUID(), j.req.DeployID),
		User:           fmt.Sprintf("%d:%d", uid, gid),
		WorkingDir:     "/tmp",
		Mounts:         []engine.Mount{{Source: cache, Target: "/cache"}, {Source: passwdFile, Target: "/etc/passwd", ReadOnly: true}},
		ReadOnlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"},
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		Resources:      s.limits(sv),
		NetworkMode:    server.SiteNetwork(sv.UUID()),
		Init:           true,
	}
}

const buildScript = `set -eu
umask 022
cd /home/container
mkdir -p .panel-deploy/home
R=".panel-deploy/release-$DEPLOY_ID"
rm -rf "$R"
mkdir "$R"
tar -x -f /release.tar -C "$R"
S="$R"
[ "$DEPLOY_SOURCE" = "." ] || S="$R/$DEPLOY_SOURCE"
if [ -n "${DEPLOY_BUILD:-}" ]; then
  if [ -d "$S" ] && [ -n "$DEPLOY_SHARED" ]; then
    printf '%s\n' "$DEPLOY_SHARED" | while IFS= read -r p; do
      f="$DEPLOY_TARGET/$p"
      if [ -n "$p" ] && [ -f "$f" ] && [ ! -L "$f" ] && [ "$(wc -c < "$f")" -le 10485760 ]; then
        mkdir -p "$(dirname "$S/$p")" && rm -rf "$S/$p" && cp "$f" "$S/$p" && echo "Using shared file $p for the build" || true
      fi
    done
  fi
  cd "$R"
  echo "\$ $DEPLOY_BUILD"
  sh -c "$DEPLOY_BUILD"
  cd /home/container
fi
if [ ! -d "$S" ] || [ -L "$S" ]; then
  echo "Folder /$DEPLOY_SOURCE does not exist in the repository (after the build)." >&2
  exit 3
fi
`

func (s *Service) buildConfig(sv *server.Server, j *job, image, cache string) engine.ContainerConfig {
	uid, gid := s.Mgr.Owner()
	home := "/home/container/" + stageDir + "/home"
	env := []string{
		"DEPLOY_ID=" + strconv.Itoa(j.req.DeployID),
		"DEPLOY_SOURCE=" + j.req.SourceDir,
		"DEPLOY_TARGET=/home/container/" + j.req.TargetDir,
		"DEPLOY_SHARED=" + strings.Join(j.req.SharedPaths, "\n"),
		"HOME=" + home, "XDG_CACHE_HOME=" + home + "/.cache", "npm_config_cache=" + home + "/.npm",
		"COMPOSER_HOME=" + home + "/.composer", "CI=true", "TZ=Europe/Amsterdam",
		"PANEL_DEPLOY_BRANCH=" + j.req.Branch,
	}
	net := "none"
	if j.req.Build != nil {
		env = append(env, "DEPLOY_BUILD="+j.req.Build.Command)
		net = server.SiteNetwork(sv.UUID())
	}
	j.mu.Lock()
	if j.commit != nil {
		env = append(env, "PANEL_DEPLOY_COMMIT="+j.commit.SHA)
	}
	j.mu.Unlock()
	return engine.ContainerConfig{
		Name:           buildName(sv.UUID()),
		Image:          image,
		Entrypoint:     []string{"/bin/sh", "-c"},
		Cmd:            []string{buildScript},
		Env:            env,
		Labels:         s.labels(sv.UUID(), j.req.DeployID),
		User:           fmt.Sprintf("%d:%d", uid, gid),
		WorkingDir:     "/home/container",
		Mounts:         []engine.Mount{{Source: s.Mgr.Volume(sv.UUID()), Target: "/home/container"}, {Source: filepath.Join(cache, "release.tar"), Target: "/release.tar", ReadOnly: true}},
		ReadOnlyRootfs: true,
		Tmpfs:          map[string]string{"/tmp": "rw,exec,nosuid,nodev,size=512m,mode=1777"},
		CapDrop:        []string{"ALL"},
		SecurityOpt:    []string{"no-new-privileges"},
		Resources:      s.limits(sv),
		NetworkMode:    net,
		Init:           true,
	}
}
