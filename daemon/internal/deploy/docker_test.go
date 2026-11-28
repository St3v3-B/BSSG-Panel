package deploy

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
	"panel/daemon/internal/spec"
)

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=Ada Lovelace", "-c", "user.email=ada@panel.test", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// TestRealDockerDeploy: echte git-fetch over smart HTTP (met token) in een container, build,
// gedeelde paden, tweede deploy (pull uit de cache), mislukte build en verkeerd token.
func TestRealDockerDeploy(t *testing.T) {
	if os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("PANEL_SKIP_DOCKER_TESTS=1")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("geen git op de host")
	}
	eng, err := engine.NewDocker()
	if err != nil {
		t.Skip("geen Docker:", err)
	}
	ctx := context.Background()
	if _, err := eng.Version(ctx); err != nil {
		t.Skip("geen Docker:", err)
	}
	instance := fmt.Sprintf("gitdeploy-%d", os.Getpid())
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		f := filters.NewArgs(filters.Arg("label", "panel.test=true"), filters.Arg("label", "panel.instance="+instance))
		list, _ := cli.ContainerList(context.Background(), container.ListOptions{All: true, Filters: f})
		for _, c := range list {
			_ = cli.ContainerRemove(context.Background(), c.ID, container.RemoveOptions{Force: true})
		}
		nets, _ := cli.NetworkList(context.Background(), network.ListOptions{Filters: f})
		for _, n := range nets {
			_ = cli.NetworkRemove(context.Background(), n.ID)
		}
	})
	tmp := t.TempDir()

	// Testserver bouwen (statisch, draait in alpine/git).
	bin := filepath.Join(tmp, "githttp")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", bin, "./testdata/githttp")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build githttp: %v\n%s", err, out)
	}
	// Bare repo met een eerste commit.
	repos := filepath.Join(tmp, "repos")
	work := filepath.Join(tmp, "work")
	for _, d := range []string{repos, work} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	gitCmd(t, repos, "init", "-q", "--bare", "site.git")
	gitCmd(t, work, "init", "-q")
	write(t, work, "index.html", "v1")
	write(t, work, ".env", "FROM_REPO=1")
	write(t, work, "uploads/.gitkeep", "")
	gitCmd(t, work, "add", "-A")
	gitCmd(t, work, "commit", "-q", "-m", "First version")
	gitCmd(t, work, "push", "-q", filepath.Join(repos, "site.git"), "HEAD:refs/heads/main")

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if os.Getenv("DAEMON_TEST_LOG") == "1" {
		log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	dataDir := filepath.Join(tmp, "data")
	mgr := server.NewManager(server.Config{
		DataDir: dataDir, Instance: instance, ExtraLabels: map[string]string{"panel.test": "true"},
		NetworkPool: netip.MustParsePrefix("10.249.0.0/16"), MariaDB: "panel-mariadb-test-" + instance,
	}, eng, nopRep{}, log)
	t.Cleanup(mgr.Close)
	port := 8080
	uuid := fmt.Sprintf("6d000000-0000-4000-8000-%012d", os.Getpid())
	sv, _, err := mgr.Create(spec.ServerSpec{UUID: uuid, Type: "web", Image: "alpine:3.20", Startup: "sleep 3600", Stop: spec.Stop{Type: "signal", Value: "SIGTERM"},
		Limits: spec.Limits{MemoryMB: 256, CPUPct: 100, DiskMB: 512}, HTTPPort: &port, SkipInstall: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mgr.Delete(uuid) })
	if err := mgr.EnsureServerNetwork(ctx, uuid); err != nil {
		t.Fatal(err)
	}
	if err := eng.EnsureImage(ctx, DefaultGitImage, nil); err != nil {
		t.Fatal(err)
	}
	if err := eng.EnsureImage(ctx, "alpine:3.20", nil); err != nil {
		t.Fatal(err)
	}
	srvName := "gitsrv-" + instance
	id, err := eng.Create(ctx, engine.ContainerConfig{
		Name: srvName, Image: DefaultGitImage, Entrypoint: []string{"/githttp"},
		Env:         []string{"REPO_ROOT=/repos", "TOKEN=s3cret-token-value"},
		Labels:      map[string]string{"panel.test": "true", "panel.instance": instance},
		Mounts:      []engine.Mount{{Source: bin, Target: "/githttp", ReadOnly: true}, {Source: repos, Target: "/repos"}},
		NetworkMode: server.SiteNetwork(uuid), Resources: engine.Resources{Memory: 128 << 20, MemorySwap: 128 << 20, PidsLimit: 64},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.Start(ctx, id); err != nil {
		t.Fatal(err)
	}

	vol := mgr.Volume(uuid)
	write(t, vol, "public/index.html", "v0")
	write(t, vol, "public/.env", "LIVE=1")
	write(t, vol, "public/uploads/a.jpg", "photo")
	uid, gid := mgr.Owner()
	_ = filepath.Walk(vol, func(p string, _ os.FileInfo, _ error) error { return os.Lchown(p, uid, gid) })

	res := &results{got: map[int]Result{}, ch: make(chan int, 10)}
	svc := &Service{Mgr: mgr, Rep: res, Log: log, AllowHTTP: true}
	svc.Cleanup(ctx)
	req := func(id int, buildCmd string) Request {
		r := Request{DeployID: id, RepoURL: "http://" + srvName + ":8080/site.git", Branch: "main", TargetDir: "/public", SourceDir: "/",
			Auth: Auth{Type: "token", Token: "s3cret-token-value"}, SharedPaths: []string{".env", "uploads"}, TimeoutSeconds: 300}
		if buildCmd != "" {
			r.Build = &Build{Command: buildCmd, Image: "alpine:3.20"}
		}
		return r
	}
	run := func(r Request) Result {
		t.Helper()
		if err := svc.Start(sv, r); err != nil {
			t.Fatal(err)
		}
		select {
		case <-res.ch:
		case <-time.After(4 * time.Minute):
			t.Fatal("deploy did not finish")
		}
		res.mu.Lock()
		defer res.mu.Unlock()
		out := res.got[r.DeployID]
		for _, l := range out.LogTail {
			if strings.Contains(l, "s3cret-token-value") {
				t.Fatalf("token in log: %q", l)
			}
		}
		return out
	}
	dump := func(r Result) string { return strings.Join(r.LogTail, "\n") }

	// 1. Eerste deploy met build: de build ziet de gedeelde .env.
	r1 := run(req(1, `echo "built from $(cat .env)" > built.txt`))
	if r1.Status != "succeeded" {
		t.Fatalf("deploy 1: %+v\n%s", r1, dump(r1))
	}
	if r1.Commit == nil || r1.Commit.Message != "First version" || r1.Commit.Author != "Ada Lovelace" || len(r1.Commit.SHA) != 40 {
		t.Fatalf("commit %+v", r1.Commit)
	}
	for p, want := range map[string]string{"public/index.html": "v1", "public/.env": "LIVE=1", "public/uploads/a.jpg": "photo", "public/built.txt": "built from LIVE=1\n"} {
		if got := read(t, vol, p); got != want {
			t.Errorf("deploy 1: %s = %q, want %q\n%s", p, got, want, dump(r1))
		}
	}
	if _, err := os.Stat(filepath.Join(vol, "public/.git")); err == nil {
		t.Error(".git must not be published")
	}

	t.Log(dump(r1))

	// 2. Nieuwe commit: fetch uit de bestaande cache.
	write(t, work, "index.html", "v2")
	gitCmd(t, work, "commit", "-q", "-am", "Second version")
	gitCmd(t, work, "push", "-q", filepath.Join(repos, "site.git"), "HEAD:refs/heads/main")
	r2 := run(req(2, ""))
	if r2.Status != "succeeded" || r2.Commit == nil || r2.Commit.Message != "Second version" {
		t.Fatalf("deploy 2: %+v\n%s", r2, dump(r2))
	}
	if read(t, vol, "public/index.html") != "v2" || read(t, vol, "public/uploads/a.jpg") != "photo" || read(t, vol, "public/built.txt") != "<missing>" {
		t.Fatalf("deploy 2 files wrong\n%s", dump(r2))
	}

	// 3. Mislukte build: de site blijft op v2.
	write(t, work, "index.html", "v3")
	gitCmd(t, work, "commit", "-q", "-am", "Broken")
	gitCmd(t, work, "push", "-q", filepath.Join(repos, "site.git"), "HEAD:refs/heads/main")
	r3 := run(req(3, "echo compiling; exit 7"))
	if r3.Status != "failed" || !strings.Contains(*r3.Error, "code 7") || !strings.Contains(dump(r3), "compiling") {
		t.Fatalf("deploy 3: %+v\n%s", r3, dump(r3))
	}
	if read(t, vol, "public/index.html") != "v2" {
		t.Fatal("live site changed after a failed build")
	}

	// 4. Verkeerd token: mislukt, geen geheim in de log.
	r4r := req(4, "")
	r4r.Auth.Token = "wrong-token-xyz"
	r4 := run(r4r)
	if r4.Status != "failed" || strings.Contains(dump(r4), "wrong-token-xyz") {
		t.Fatalf("deploy 4: %+v\n%s", r4, dump(r4))
	}
	// 5. Onbekende branch.
	r5r := req(5, "")
	r5r.Branch = "does-not-exist"
	if r5 := run(r5r); r5.Status != "failed" {
		t.Fatalf("deploy 5: %+v", r5)
	}
	if read(t, vol, "public/index.html") != "v2" {
		t.Fatal("live site changed")
	}
	// Geen deploy-containers over.
	l := mgr.BaseLabels()
	l["panel.role"] = "install"
	if left, _ := eng.List(ctx, l); len(left) != 0 {
		t.Fatalf("containers left: %d", len(left))
	}
}
