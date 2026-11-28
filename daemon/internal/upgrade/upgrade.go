// Package upgrade laat het panel zichzelf bijwerken: status (git) en het gedetacheerd starten van
// deploy/upgrade.sh via systemd-run. Alleen actief op de lokale node (PANEL_REPO_DIR gezet).
package upgrade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	// ErrNotLocal: geen checkout of upgrade.sh op deze node.
	ErrNotLocal = errors.New("this node has no panel checkout (PANEL_REPO_DIR)")
	// ErrBadRef: geen origin/main en geen hex-sha.
	ErrBadRef = errors.New("ref must be origin/main or a hex commit sha (7-40 characters)")
	// ErrRunning: er draait al een upgrade.
	ErrRunning = errors.New("an upgrade is already running")
)

var refRe = regexp.MustCompile(`^(origin/main|[0-9a-f]{7,40})$`)

// ValidRef geeft aan of ref veilig aan upgrade.sh doorgegeven mag worden.
func ValidRef(ref string) bool { return refRe.MatchString(ref) }

// Runner voert een commando uit en geeft de stdout terug (tests vervangen dit).
type Runner func(ctx context.Context, name string, args ...string) (string, error)

// ExecRunner is de echte Runner.
func ExecRunner(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

// Service bundelt de instellingen.
type Service struct {
	RepoDir    string // PANEL_REPO_DIR
	UpgradeDir string // $DATA_DIR/upgrade
	Run        Runner
	Now        func() time.Time
	// PidAlive controleert of het pid uit status.json nog leeft (tests vervangen dit).
	PidAlive func(pid int) bool

	mu sync.Mutex
}

// Commit is een commit.
type Commit struct {
	SHA     string  `json:"sha"`
	Date    *string `json:"date"`
	Message string  `json:"message"`
	Author  *string `json:"author,omitempty"`
}

// Status is het PanelUpgradeStatus-schema (zonder daemonversie; die vult de API in).
type Status struct {
	Current    Commit          `json:"current"`
	Commits    []Commit        `json:"commits"`
	FetchError *string         `json:"fetch_error"`
	Origin     *string         `json:"origin"`
	Upgrade    json.RawMessage `json:"upgrade"`
	LogTail    string          `json:"log_tail"`
	// Versienummers: aantal commits tot en met HEAD / origin/main (`git rev-list --count`); nil = onbekend.
	CurrentNumber *int `json:"current_number"`
	LatestNumber  *int `json:"latest_number"`
	// Exact aantal commits in HEAD..origin/main (Commits is begrensd op 50).
	Behind *int `json:"behind"`
	// Laatste geslaagde `git fetch` (mtime van FETCH_HEAD, RFC 3339); nil = nooit.
	LastFetch *string `json:"last_fetch"`
}

// Start is het antwoord op een gestarte upgrade.
type Start struct {
	Unit      string    `json:"unit"`
	StartedAt time.Time `json:"started_at"`
}

func (s *Service) script() string { return filepath.Join(s.RepoDir, "deploy", "upgrade.sh") }

func (s *Service) run(ctx context.Context) Runner {
	if s.Run != nil {
		return s.Run
	}
	return ExecRunner
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Enabled: er is een checkout met upgrade.sh.
func (s *Service) Enabled() bool {
	if s == nil || s.RepoDir == "" {
		return false
	}
	st, err := os.Stat(s.script())
	return err == nil && !st.IsDir()
}

func (s *Service) git(ctx context.Context, args ...string) (string, error) {
	a := append([]string{"-C", s.RepoDir, "-c", "safe.directory=" + s.RepoDir}, args...)
	return s.run(ctx)(ctx, "git", a...)
}

func parseCommits(out string) []Commit {
	var cs []Commit
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Split(line, "\x1f")
		if len(f) < 3 || f[0] == "" {
			continue
		}
		c := Commit{SHA: f[0], Message: f[2]}
		if f[1] != "" {
			d := f[1]
			c.Date = &d
		}
		if len(f) > 3 && f[3] != "" {
			a := f[3]
			c.Author = &a
		}
		cs = append(cs, c)
	}
	return cs
}

const format = "--format=%H%x1f%cI%x1f%s%x1f%an"

// Status leest de checkout; met fetch eerst `git fetch origin` (een fout daarvan komt in FetchError).
func (s *Service) Status(ctx context.Context, fetch bool) (Status, error) {
	if !s.Enabled() {
		return Status{}, ErrNotLocal
	}
	st := Status{Commits: []Commit{}}
	if fetch {
		fctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		_, err := s.git(fctx, "fetch", "--quiet", "origin")
		cancel()
		if err != nil {
			e := err.Error()
			st.FetchError = &e
		}
	}
	if o, err := s.git(ctx, "remote", "get-url", "origin"); err == nil && strings.TrimSpace(o) != "" {
		u := strings.TrimSpace(o)
		st.Origin = &u
	}
	out, err := s.git(ctx, "log", "-1", format, "HEAD")
	if err != nil {
		return st, fmt.Errorf("git log: %w", err)
	}
	if cs := parseCommits(out); len(cs) == 1 {
		st.Current = cs[0]
	}
	if out, err := s.git(ctx, "log", "-n", "50", format, "HEAD..origin/main"); err == nil {
		st.Commits = append(st.Commits, parseCommits(out)...)
	} else if st.FetchError == nil {
		e := err.Error()
		st.FetchError = &e
	}
	st.CurrentNumber = s.count(ctx, "HEAD")
	st.LatestNumber = s.count(ctx, "origin/main")
	st.Behind = s.count(ctx, "HEAD..origin/main")
	st.LastFetch = s.lastFetch(ctx)
	if b, err := os.ReadFile(filepath.Join(s.UpgradeDir, "status.json")); err == nil && json.Valid(b) {
		st.Upgrade = json.RawMessage(bytes.TrimSpace(b))
	}
	st.LogTail = s.logTail(40)
	return st, nil
}

// count geeft `git rev-list --count <rev>`, of nil als dat niet lukt.
func (s *Service) count(ctx context.Context, rev string) *int {
	out, err := s.git(ctx, "rev-list", "--count", rev)
	if err != nil {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil || n < 0 {
		return nil
	}
	return &n
}

// lastFetch: mtime van FETCH_HEAD (git werkt die bij elke geslaagde fetch bij).
func (s *Service) lastFetch(ctx context.Context) *string {
	out, err := s.git(ctx, "rev-parse", "--git-path", "FETCH_HEAD")
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}
	p := strings.TrimSpace(out)
	if !filepath.IsAbs(p) {
		p = filepath.Join(s.RepoDir, p)
	}
	fi, err := os.Stat(p)
	if err != nil {
		return nil
	}
	t := fi.ModTime().UTC().Format(time.RFC3339)
	return &t
}

func (s *Service) logTail(lines int) string {
	logs, _ := filepath.Glob(filepath.Join(s.UpgradeDir, "upgrade-*.log"))
	if len(logs) == 0 {
		return ""
	}
	sort.Strings(logs) // timestamp in de naam
	b, err := os.ReadFile(logs[len(logs)-1])
	if err != nil {
		return ""
	}
	if len(b) > 64<<10 {
		b = b[len(b)-64<<10:]
	}
	l := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(l) > lines {
		l = l[len(l)-lines:]
	}
	return strings.Join(l, "\n")
}

func (s *Service) alive(pid int) bool {
	if s.PidAlive != nil {
		return s.PidAlive(pid)
	}
	_, err := os.Stat("/proc/" + strconv.Itoa(pid))
	return err == nil
}

func (s *Service) running() bool {
	b, err := os.ReadFile(filepath.Join(s.UpgradeDir, "status.json"))
	if err != nil {
		return false
	}
	var st struct {
		State string `json:"state"`
		PID   int    `json:"pid"`
	}
	if json.Unmarshal(b, &st) != nil || st.State != "running" {
		return false
	}
	return st.PID <= 0 || s.alive(st.PID)
}

// Start start upgrade.sh gedetacheerd (systemd-run), zodat een herstart van de daemon hem niet doodt.
func (s *Service) Start(ctx context.Context, ref string) (Start, error) {
	if !s.Enabled() {
		return Start{}, ErrNotLocal
	}
	if ref == "" {
		ref = "origin/main"
	}
	if !ValidRef(ref) {
		return Start{}, ErrBadRef
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running() {
		return Start{}, ErrRunning
	}
	now := s.now().UTC()
	unit := "panel-upgrade-" + now.Format("20060102T150405Z")
	_, err := s.run(ctx)(ctx, "systemd-run", "--unit", unit, "--collect", "--description=panel upgrade",
		"--working-directory="+s.RepoDir,
		"--setenv=PANEL_REPO_DIR="+s.RepoDir, "--setenv=PANEL_UPGRADE_DIR="+s.UpgradeDir,
		s.script(), "--ref", ref)
	if err != nil {
		return Start{}, fmt.Errorf("systemd-run: %w", err)
	}
	return Start{Unit: unit, StartedAt: now}, nil
}
