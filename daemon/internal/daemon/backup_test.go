package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/testpanel"
)

// cutProxy is een TCP-proxy die na cutAfter bytes richting de client alle verbindingen
// verbreekt en niets meer accepteert: "S3 valt weg tijdens de download".
type cutProxy struct {
	ln       net.Listener
	target   string
	cutAfter atomic.Int64 // 0 = niet geactiveerd
	sent     atomic.Int64
	mu       sync.Mutex
	conns    []net.Conn
	cut      atomic.Bool
}

func newCutProxy(t *testing.T, target string) *cutProxy {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &cutProxy{ln: ln, target: target}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				c.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, c, up)
			p.mu.Unlock()
			go func() { _, _ = io.Copy(up, c); up.Close() }()
			go func() {
				buf := make([]byte, 32<<10)
				for {
					n, err := up.Read(buf)
					if n > 0 {
						if lim := p.cutAfter.Load(); lim > 0 && p.sent.Add(int64(n)) > lim {
							p.cutNow()
							return
						}
						if _, werr := c.Write(buf[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						c.Close()
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() { ln.Close(); p.cutNow() })
	return p
}

func (p *cutProxy) cutNow() {
	p.cut.Store(true)
	p.ln.Close()
	p.mu.Lock()
	for _, c := range p.conns {
		c.Close()
	}
	p.mu.Unlock()
}

func (p *cutProxy) addr() string { return p.ln.Addr().String() }

func dirTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		switch {
		case d.IsDir():
			out[rel] = "dir"
		case d.Type()&os.ModeSymlink != 0:
			l, _ := os.Readlink(p)
			out[rel] = "link:" + l
		default:
			b, _ := os.ReadFile(p)
			s := sha256.Sum256(b)
			out[rel] = hex.EncodeToString(s[:8])
		}
		return nil
	})
	return out
}

// TestRealDockerBackupRestore: S3 (rclone serve s3, zoals op de Unraid-server) en MariaDB
// in eigen testcontainers. Backup → S3 → herstel met database, foute checksum en een
// afgebroken download.
func TestRealDockerBackupRestore(t *testing.T) {
	if os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("PANEL_SKIP_DOCKER_TESTS=1")
	}
	eng, err := engine.NewDocker()
	if err != nil {
		t.Skip("geen Docker:", err)
	}
	ctx := context.Background()
	if _, err := eng.Version(ctx); err != nil {
		t.Skip("geen Docker:", err)
	}
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	instance := fmt.Sprintf("backups-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	labels := map[string]string{"panel.test": "true", "panel.instance": instance}
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
	for _, img := range []string{"rclone/rclone:latest", "mariadb:11", "alpine:3.20"} {
		if err := eng.EnsureImage(ctx, img, nil); err != nil {
			t.Skip("image niet beschikbaar:", img, err)
		}
	}

	// S3.
	s3Port := freePort(t)
	s3Name := "s3-" + instance
	if _, err := cli.ContainerCreate(ctx, &container.Config{
		Image: "rclone/rclone:latest", Cmd: []string{"serve", "s3", "/data", "--addr", ":9000", "--auth-key", "AKTEST,SKTEST-secret-1"},
		Labels: labels, ExposedPorts: nat.PortSet{"9000/tcp": {}},
	}, &container.HostConfig{PortBindings: nat.PortMap{"9000/tcp": {{HostIP: "127.0.0.1", HostPort: fmt.Sprint(s3Port)}}}}, nil, nil, s3Name); err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, s3Name, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	s3Addr := fmt.Sprintf("127.0.0.1:%d", s3Port)
	mc, err := minio.New(s3Addr, &minio.Options{Creds: credentials.NewStaticV4("AKTEST", "SKTEST-secret-1", ""), BucketLookup: minio.BucketLookupPath})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "S3 bereikbaar", 30*time.Second, func() bool {
		return mc.MakeBucket(ctx, "backups", minio.MakeBucketOptions{}) == nil
	})
	proxy := newCutProxy(t, s3Addr)
	s3 := func(addr string) map[string]any {
		return map[string]any{"endpoint": "http://" + addr, "bucket": "backups", "region": "us-east-1", "access_key": "AKTEST", "secret_key": "SKTEST-secret-1", "path_style": true}
	}

	// MariaDB (eigen naam, nooit de echte panel-mariadb).
	dbName := "panel-mariadb-" + instance
	if _, err := cli.ContainerCreate(ctx, &container.Config{Image: "mariadb:11", Env: []string{"MARIADB_ROOT_PASSWORD=rootpw", "MARIADB_DATABASE=site", "MARIADB_USER=siteu", "MARIADB_PASSWORD=sitepw"}, Labels: labels}, &container.HostConfig{}, nil, nil, dbName); err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, dbName, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	sql := func(q string) (string, int) {
		ex, _ := cli.ContainerExecCreate(ctx, dbName, container.ExecOptions{Cmd: []string{"mariadb", "-h127.0.0.1", "-uroot", "-prootpw", "-N", "-B", "site", "-e", q}, AttachStdout: true, AttachStderr: true})
		att, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
		if err != nil {
			t.Fatal(err)
		}
		var ob, eb bytes.Buffer
		_, _ = stdcopy.StdCopy(&ob, &eb, att.Reader)
		b := append(ob.Bytes(), eb.Bytes()...)
		att.Close()
		for i := 0; i < 100; i++ {
			if r, err := cli.ContainerExecInspect(ctx, ex.ID); err == nil && !r.Running {
				return string(bytes.TrimSpace(b)), r.ExitCode
			}
			time.Sleep(50 * time.Millisecond)
		}
		return string(b), -1
	}
	waitFor(t, "MariaDB klaar", 90*time.Second, func() bool {
		out, code := sql("select 1")
		return code == 0 && strings.Contains(out, "1")
	})
	if out, code := sql("create table notes (id int primary key, txt varchar(50)); insert into notes values (1,'one'),(2,'two')"); code != 0 {
		t.Fatal(out)
	}

	// Daemon met een website.
	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, func(c *config.Config, _ *Deps) { c.MariaDBContainer = dbName })
	site := randUUID()
	h.expect("POST", "/api/servers", map[string]any{
		"uuid": site, "type": "web", "image": "alpine:3.20", "http_port": 8080,
		"startup": "sleep 600", "stop": map[string]string{"type": "signal", "value": "SIGKILL"},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 0},
		"allocations": []any{}, "skip_install": true,
		"install": map[string]string{"image": "alpine:3.20", "script": "true"},
	}, 202)
	vol := filepath.Join(h.cfg.DataDir, "volumes", site)
	write := func(rel, content string) {
		p := filepath.Join(vol, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		_ = os.Chown(p, 1000, 1000)
	}
	write("index.php", "<?php echo 'hoi';")
	write("wp/config.php", "secret=1")
	write("logs/big.log", "skip me")
	write("cache/a/b.tmp", "skip me too")
	rnd := make([]byte, 6<<20)
	rand.New(rand.NewSource(1)).Read(rnd)
	write("uploads/random.bin", string(rnd))
	if err := os.Symlink("wp/config.php", filepath.Join(vol, "link")); err != nil {
		t.Fatal(err)
	}
	original := dirTree(t, vol)
	for _, k := range []string{"logs", "logs/big.log", "cache", "cache/a", "cache/a/b.tmp"} {
		delete(original, k) // wat de backup (met ignore) niet bevat
	}
	_ = os.RemoveAll(filepath.Join(vol, "logs"))
	_ = os.RemoveAll(filepath.Join(vol, "cache"))
	original = dirTree(t, vol)
	original["logs"] = "dir" // "logs/*" sluit de inhoud uit, niet de map zelf
	write("logs/big.log", "skip me")
	write("cache/a/b.tmp", "skip me too")

	ws := h.ws(site, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: site, Permissions: []string{"console.read"}})})
	ws.next("auth_success", 5*time.Second, ev("auth_success"))

	dbCreds := []map[string]any{{"name": "site", "host": dbName, "port": 3306, "username": "siteu", "password": "sitepw"}}
	key := "servers/" + site + "/1.tar.zst"
	h.expect("POST", "/api/servers/"+site+"/backups", map[string]any{
		"backup_id": 1, "s3": s3(s3Addr), "key": key, "ignore": []string{"logs/*", "cache/", "*.tmp"}, "databases": dbCreds,
	}, 202)
	var report map[string]any
	waitFor(t, "backup-rapport", 120*time.Second, func() bool {
		c := h.panel.Calls("/api/remote/backups/1")
		if len(c) == 0 {
			return false
		}
		report = c[len(c)-1].Body
		return true
	})
	if report["successful"] != true {
		t.Fatalf("backup mislukt: %v", report)
	}
	ws.next("backup_progress 100", 5*time.Second, func(m map[string]any) bool {
		return m["event"] == "backup_progress" && m["percent"] == float64(100)
	})
	sha, _ := report["sha256"].(string)
	obj, err := mc.GetObject(ctx, "backups", key, minio.GetObjectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(obj)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != sha || int64(len(b)) != int64(report["size_bytes"].(float64)) {
		t.Fatalf("checksum of size komt niet overeen met het object: %s vs %x (%d)", sha, sum, len(b))
	}
	if len(b) < 5<<20 {
		t.Fatalf("archief verdacht klein: %d", len(b))
	}

	noTemp := func() {
		t.Helper()
		ents, _ := os.ReadDir(filepath.Dir(vol))
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".restore-") || strings.HasPrefix(e.Name(), ".old-") || strings.HasSuffix(e.Name(), ".failed") {
				t.Fatalf("tijdelijke map blijft staan: %s", e.Name())
			}
		}
	}
	restore := func(n int, addr, sum string) map[string]any {
		t.Helper()
		h.expect("POST", fmt.Sprintf("/api/servers/%s/backups/1/restore", site), map[string]any{"s3": s3(addr), "key": key, "sha256": sum, "databases": dbCreds}, 202)
		var rep map[string]any
		waitFor(t, "restore-rapport", 120*time.Second, func() bool {
			c := h.panel.Calls("/api/remote/backups/1/restore")
			if len(c) < n {
				return false
			}
			rep = c[n-1].Body
			return true
		})
		return rep
	}

	// Wijzig alles, zodat een herstel zichtbaar is.
	write("index.php", "CHANGED")
	write("extra.txt", "new file")
	_ = os.Remove(filepath.Join(vol, "wp/config.php"))
	if out, code := sql("delete from notes; insert into notes values (9,'changed')"); code != 0 {
		t.Fatal(out)
	}
	changed := dirTree(t, vol)

	// 1. Foute checksum: afgebroken, data ongemoeid, geen resten.
	rep := restore(1, s3Addr, strings.Repeat("0", 64))
	if rep["successful"] != false || !strings.Contains(fmt.Sprint(rep["error"]), "checksum") {
		t.Fatalf("verwacht checksum-fout: %v", rep)
	}
	if got := dirTree(t, vol); fmt.Sprint(got) != fmt.Sprint(changed) {
		t.Fatalf("data veranderd na mislukt herstel:\n%v\n%v", got, changed)
	}
	if out, _ := sql("select group_concat(txt) from notes"); out != "changed" {
		t.Fatalf("database veranderd: %q", out)
	}
	noTemp()

	// 2. S3 valt weg midden in de download.
	proxy.cutAfter.Store(1 << 20)
	rep = restore(2, proxy.addr(), sha)
	if rep["successful"] != false {
		t.Fatalf("verwacht fout: %v", rep)
	}
	if got := dirTree(t, vol); fmt.Sprint(got) != fmt.Sprint(changed) {
		t.Fatalf("data veranderd na afgebroken herstel")
	}
	if !proxy.cut.Load() {
		t.Fatal("proxy heeft niet afgebroken")
	}
	noTemp()

	// 3. Goed herstel.
	rep = restore(3, s3Addr, sha)
	if rep["successful"] != true {
		t.Fatalf("herstel mislukt: %v", rep)
	}
	got := dirTree(t, vol)
	if fmt.Sprint(got) != fmt.Sprint(original) {
		t.Fatalf("herstelde data wijkt af:\n got: %v\nwant: %v", got, original)
	}
	if fi, err := os.Stat(vol); err != nil || fi.Mode().Perm() != 0o750 {
		t.Fatalf("map: %v %v", fi, err)
	}
	if out, _ := sql("select group_concat(txt order by id) from notes"); out != "one,two" {
		t.Fatalf("database niet hersteld: %q", out)
	}
	noTemp()
	// De gedeelde dumpmap is opgeruimd.
	if ents, _ := os.ReadDir(filepath.Join(h.cfg.DataDir, "tmp")); len(ents) != 0 {
		t.Fatalf("tmp niet leeg: %v", ents)
	}
	// Credentials staan nergens op schijf.
	_ = filepath.WalkDir(h.cfg.DataDir, func(p string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() && !strings.Contains(p, "/volumes/") {
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte("SKTEST-secret-1")) || bytes.Contains(b, []byte("sitepw")) {
				t.Errorf("credentials op schijf in %s", p)
			}
		}
		return nil
	})
	h.expect("DELETE", "/api/servers/"+site, nil, 204)
}
