package deploy

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/server"
	"panel/daemon/internal/spec"
)

type nopRep struct{}

func (nopRep) ReportStatus(string, string)        {}
func (nopRep) ReportInstall(string, bool, string) {}
func (nopRep) ReportEvent(string, panel.Event)    {}

type results struct {
	mu  sync.Mutex
	got map[int]Result
	ch  chan int
}

func (r *results) ReportDeploy(id int, res Result) {
	r.mu.Lock()
	r.got[id] = res
	r.mu.Unlock()
	r.ch <- id
}

func (r *results) wait(t *testing.T, id int) Result {
	t.Helper()
	select {
	case got := <-r.ch:
		if got != id {
			t.Fatalf("result for %d, want %d", got, id)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("no result for deploy %d", id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.got[id]
}

func env(c engine.ContainerConfig, k string) string {
	for _, e := range c.Env {
		if v, ok := strings.CutPrefix(e, k+"="); ok {
			return v
		}
	}
	return ""
}

func mountSrc(c engine.ContainerConfig, target string) string {
	for _, m := range c.Mounts {
		if m.Target == target {
			return m.Source
		}
	}
	return ""
}

func makeTar(files map[string]string) []byte {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, content := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(content))
	}
	_ = tw.Close()
	return buf.Bytes()
}

func untar(data []byte, dir string) error {
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		p := filepath.Join(dir, h.Name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		b, _ := io.ReadAll(tr)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return err
		}
	}
}

type fakeDeploy struct {
	t       *testing.T
	eng     *engine.Fake
	mgr     *server.Manager
	svc     *Service
	res     *results
	sv      *server.Server
	vol     string
	repo    map[string]string
	gitFail bool
	// block: de build-container wacht tot hij gekild wordt.
	block   chan struct{}
	configs []engine.ContainerConfig
	mu      sync.Mutex
}

func newFakeDeploy(t *testing.T) *fakeDeploy {
	f := &fakeDeploy{t: t, eng: engine.NewFake(), repo: map[string]string{"index.html": "v1", ".env": "FROM_REPO=1"}}
	f.eng.Behavior = func(c *engine.FakeContainer) {
		name := c.Config.Name
		f.mu.Lock()
		f.configs = append(f.configs, c.Config)
		f.mu.Unlock()
		switch {
		case strings.HasSuffix(name, "-deploy-git"):
			c.Println("Fetching origin with " + env(c.Config, "DEPLOY_TOKEN"))
			if f.gitFail {
				c.Println("fatal: could not read from remote repository")
				c.Exit(128)
				return
			}
			f.mu.Lock()
			data := makeTar(f.repo)
			f.mu.Unlock()
			_ = os.WriteFile(filepath.Join(mountSrc(c.Config, "/cache"), "release.tar"), data, 0o644)
			c.Println("::commit::0123456789abcdef0123456789abcdef01234567\x1fAda Lovelace\x1f2026-11-01T10:00:00+01:00\x1fFix the header")
			c.Exit(0)
		case strings.HasSuffix(name, "-deploy-build"):
			data, _ := os.ReadFile(mountSrc(c.Config, "/release.tar"))
			rel := filepath.Join(mountSrc(c.Config, "/home/container"), ".panel-deploy", "release-"+env(c.Config, "DEPLOY_ID"))
			if err := untar(data, rel); err != nil {
				c.Println(err.Error())
				c.Exit(1)
				return
			}
			switch b := env(c.Config, "DEPLOY_BUILD"); {
			case strings.Contains(b, "fail"):
				c.Println("npm ERR! build failed")
				c.Exit(1)
			case strings.Contains(b, "block"):
				close(f.block)
				<-c.Exited()
			default:
				if b != "" {
					_ = os.WriteFile(filepath.Join(rel, "built.txt"), []byte("built"), 0o644)
				}
				c.Exit(0)
			}
		default:
			engine.DefaultBehavior(c)
		}
	}
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	f.mgr = server.NewManager(server.Config{DataDir: dir, Instance: fmt.Sprintf("gitdeploy-%d", os.Getpid()), UID: os.Getuid(), GID: os.Getgid()}, f.eng, nopRep{}, log)
	t.Cleanup(f.mgr.Close)
	port := 8080
	sp := spec.ServerSpec{UUID: "11111111-2222-3333-4444-555555555555", Type: "web", Image: "nginx:test", Startup: "nginx", Stop: spec.Stop{Type: "signal", Value: "SIGTERM"},
		Limits: spec.Limits{MemoryMB: 128, CPUPct: 100, DiskMB: 1024}, HTTPPort: &port, SkipInstall: true}
	sv, _, err := f.mgr.Create(sp)
	if err != nil {
		t.Fatal(err)
	}
	f.sv = sv
	f.vol = f.mgr.Volume(sp.UUID)
	f.res = &results{got: map[int]Result{}, ch: make(chan int, 10)}
	f.svc = &Service{Mgr: f.mgr, Rep: f.res, Log: log}
	return f
}

func (f *fakeDeploy) req(id int) Request {
	return Request{DeployID: id, RepoURL: "https://git.example.test/acme/site.git", Branch: "main", TargetDir: "/public", SourceDir: "/", Auth: Auth{Type: "token", Token: "tok_supersecret"}, SharedPaths: []string{".env", "uploads"}}
}

func TestServiceDeployFlow(t *testing.T) {
	f := newFakeDeploy(t)
	write(t, f.vol, "public/index.html", "v0")
	write(t, f.vol, "public/.env", "LIVE=1")
	write(t, f.vol, "public/uploads/a.jpg", "photo")
	r := f.req(1)
	r.Build = &Build{Command: "npm run build", Image: "node:22-alpine"}
	if err := f.svc.Start(f.sv, r); err != nil {
		t.Fatal(err)
	}
	res := f.res.wait(t, 1)
	if res.Status != "succeeded" {
		t.Fatalf("result %+v", res)
	}
	if res.Commit == nil || res.Commit.Author != "Ada Lovelace" || res.Commit.Message != "Fix the header" || res.Commit.Date == nil {
		t.Fatalf("commit %+v", res.Commit)
	}
	for p, want := range map[string]string{"public/index.html": "v1", "public/.env": "LIVE=1", "public/uploads/a.jpg": "photo", "public/built.txt": "built"} {
		if got := read(t, f.vol, p); got != want {
			t.Errorf("%s = %q, want %q", p, got, want)
		}
	}
	ents, _ := os.ReadDir(filepath.Join(f.vol, ".panel-deploy"))
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "release-") {
			t.Errorf("work folder not cleaned up: %s", e.Name())
		}
	}
	joined := strings.Join(res.LogTail, "\n")
	if strings.Contains(joined, "tok_supersecret") || !strings.Contains(joined, "Fetching origin with ***") {
		t.Errorf("log not redacted: %s", joined)
	}
	// Containerinstellingen: geen root, geen caps, labels, eigen netwerk, geheimen alleen in git.
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.configs) != 2 {
		t.Fatalf("containers: %d", len(f.configs))
	}
	uid, gid := f.mgr.Owner()
	for _, c := range f.configs {
		if c.User != fmt.Sprintf("%d:%d", uid, gid) || c.CapDrop[0] != "ALL" || !c.ReadOnlyRootfs || c.Labels["panel.role"] != "install" || c.Labels["panel.server_uuid"] != f.sv.UUID() || c.Labels["panel.managed"] != "true" {
			t.Errorf("%s: unsafe config %+v", c.Name, c)
		}
		if c.NetworkMode != server.SiteNetwork(f.sv.UUID()) {
			t.Errorf("%s: network %s", c.Name, c.NetworkMode)
		}
		if strings.Contains(strings.Join(c.Cmd, " "), "tok_supersecret") {
			t.Errorf("%s: secret on the command line", c.Name)
		}
		if c.Resources.Memory != 256*1024*1024 {
			t.Errorf("%s: memory %d (floor 256 MB)", c.Name, c.Resources.Memory)
		}
	}
	git, build := f.configs[0], f.configs[1]
	if env(git, "DEPLOY_TOKEN") != "tok_supersecret" || env(build, "DEPLOY_TOKEN") != "" {
		t.Error("token must only reach the git container")
	}
	if mountSrc(git, "/home/container") != "" {
		t.Error("the git container must not see the site files")
	}
	if build.Image != "node:22-alpine" || env(build, "DEPLOY_BUILD") != "npm run build" {
		t.Errorf("build config %+v", build)
	}
}

func TestServiceFailureKeepsLiveSite(t *testing.T) {
	f := newFakeDeploy(t)
	write(t, f.vol, "public/index.html", "v0")
	r := f.req(2)
	r.Build = &Build{Command: "npm run fail", Image: "node:22-alpine"}
	if err := f.svc.Start(f.sv, r); err != nil {
		t.Fatal(err)
	}
	res := f.res.wait(t, 2)
	if res.Status != "failed" || res.Error == nil || !strings.Contains(*res.Error, "build command exited with code 1") {
		t.Fatalf("result %+v", res)
	}
	if read(t, f.vol, "public/index.html") != "v0" {
		t.Fatal("live site changed after a failed build")
	}
	f.gitFail = true
	if err := f.svc.Start(f.sv, f.req(3)); err != nil {
		t.Fatal(err)
	}
	if res := f.res.wait(t, 3); res.Status != "failed" || !strings.Contains(*res.Error, "git exited with code 128") {
		t.Fatalf("result %+v", res)
	}
}

func TestServiceBusyAndCancel(t *testing.T) {
	f := newFakeDeploy(t)
	write(t, f.vol, "public/index.html", "v0")
	f.block = make(chan struct{})
	r := f.req(4)
	r.Build = &Build{Command: "block", Image: "node:22-alpine"}
	if err := f.svc.Start(f.sv, r); err != nil {
		t.Fatal(err)
	}
	<-f.block
	if err := f.svc.Start(f.sv, f.req(5)); !errors.Is(err, ErrBusy) {
		t.Fatalf("second deploy: %v", err)
	}
	p, ok := f.svc.Progress(f.sv.UUID())
	if !ok || p.DeployID != 4 || p.Phase != "building" || !p.Cancellable || p.Commit == nil {
		t.Fatalf("progress %+v", p)
	}
	if err := f.svc.Cancel(f.sv.UUID(), 99); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("cancel wrong id: %v", err)
	}
	if err := f.svc.Cancel(f.sv.UUID(), 4); err != nil {
		t.Fatal(err)
	}
	if res := f.res.wait(t, 4); res.Status != "cancelled" {
		t.Fatalf("result %+v", res)
	}
	if read(t, f.vol, "public/index.html") != "v0" {
		t.Fatal("live site changed after cancel")
	}
	if _, ok := f.svc.Progress(f.sv.UUID()); ok {
		t.Fatal("still running")
	}
	f.svc.Wait()
}

func TestServiceRejects(t *testing.T) {
	f := newFakeDeploy(t)
	r := f.req(6)
	r.RepoURL = "file:///etc"
	var bad *BadRequest
	if err := f.svc.Start(f.sv, r); !errors.As(err, &bad) {
		t.Fatalf("file:// accepted: %v", err)
	}
	r = f.req(7)
	r.RepoURL = "http://git.example.test/a.git"
	if err := f.svc.Start(f.sv, r); !errors.As(err, &bad) {
		t.Fatalf("http:// accepted without AllowHTTP: %v", err)
	}
}
