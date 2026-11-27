package daemon

import (
	"context"
	"fmt"
	"math/rand"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/testpanel"
)

// slowProxy is een TCP-proxy die beide richtingen afknijpt tot ongeveer bps bytes per seconde
// ("trage S3"), zodat een backup of herstel lang genoeg loopt om voortgang en annuleren te zien.
func slowProxy(t *testing.T, target string, bps int) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	pipe := func(dst, src net.Conn) {
		buf := make([]byte, 16<<10)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if _, werr := dst.Write(buf[:n]); werr != nil {
					break
				}
				time.Sleep(time.Duration(n) * time.Second / time.Duration(bps))
			}
			if err != nil {
				break
			}
		}
		dst.Close()
		src.Close()
	}
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
			mu.Lock()
			conns = append(conns, c, up)
			mu.Unlock()
			go pipe(up, c)
			go pipe(c, up)
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
	})
	return ln.Addr().String()
}

type progressBody struct {
	Progress *struct {
		BackupID    int    `json:"backup_id"`
		Operation   string `json:"operation"`
		Phase       string `json:"phase"`
		Bytes       int64  `json:"bytes"`
		TotalBytes  int64  `json:"total_bytes"`
		Percent     int    `json:"percent"`
		EtaSeconds  *int64 `json:"eta_seconds"`
		StartedAt   string `json:"started_at"`
		Cancellable bool   `json:"cancellable"`
	} `json:"progress"`
}

// TestBackupProgressAndCancel: voortgang (poll + websocket) en annuleren van backup en herstel,
// met een nep-engine (geen servercontainer) en S3 van rclone in een testcontainer achter een trage proxy.
func TestBackupProgressAndCancel(t *testing.T) {
	if os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("PANEL_SKIP_DOCKER_TESTS=1")
	}
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Skip("geen Docker:", err)
	}
	ctx := context.Background()
	if _, err := cli.Ping(ctx); err != nil {
		t.Skip("geen Docker:", err)
	}
	deng, err := engine.NewDocker()
	if err != nil {
		t.Skip("geen Docker:", err)
	}
	if err := deng.EnsureImage(ctx, "rclone/rclone:latest", nil); err != nil {
		t.Skip("rclone-image niet beschikbaar:", err)
	}
	instance := fmt.Sprintf("bprogress-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	t.Cleanup(func() {
		f := filters.NewArgs(filters.Arg("label", "panel.test=true"), filters.Arg("label", "panel.instance="+instance))
		list, _ := cli.ContainerList(context.Background(), container.ListOptions{All: true, Filters: f})
		for _, c := range list {
			_ = cli.ContainerRemove(context.Background(), c.ID, container.RemoveOptions{Force: true})
		}
	})
	s3Port := freePort(t)
	name := "s3-" + instance
	if _, err := cli.ContainerCreate(ctx, &container.Config{
		Image: "rclone/rclone:latest", Cmd: []string{"serve", "s3", "/data", "--addr", ":9000", "--auth-key", "AKTEST,SKTEST-secret-1"},
		Labels: map[string]string{"panel.test": "true", "panel.instance": instance}, ExposedPorts: nat.PortSet{"9000/tcp": {}},
	}, &container.HostConfig{PortBindings: nat.PortMap{"9000/tcp": {{HostIP: "127.0.0.1", HostPort: fmt.Sprint(s3Port)}}}}, nil, nil, name); err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, name, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	s3Addr := fmt.Sprintf("127.0.0.1:%d", s3Port)
	mc, err := minio.New(s3Addr, &minio.Options{Creds: credentials.NewStaticV4("AKTEST", "SKTEST-secret-1", ""), BucketLookup: minio.BucketLookupPath})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "S3 bereikbaar", 30*time.Second, func() bool { return mc.MakeBucket(ctx, "backups", minio.MakeBucketOptions{}) == nil })
	slow := slowProxy(t, s3Addr, 6<<20)
	s3 := func(addr string) map[string]any {
		return map[string]any{"endpoint": "http://" + addr, "bucket": "backups", "region": "us-east-1", "access_key": "AKTEST", "secret_key": "SKTEST-secret-1", "path_style": true}
	}

	h := newHarness(t, engine.NewFake(), nil, nil, "", nil, "")
	h.d.backup.ProgressEvery = 100 * time.Millisecond
	uuid := randUUID()
	h.expect("POST", "/api/servers", map[string]any{
		"uuid": uuid, "type": "game", "image": "alpine:3.20", "startup": "x", "stop": map[string]string{"type": "signal", "value": "SIGKILL"},
		"ready_pattern": "^ready$", "environment": map[string]string{}, "limits": map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 0},
		"allocations": []any{}, "skip_install": true, "install": map[string]string{"image": "alpine:3.20", "script": "true"},
	}, 202)
	vol := filepath.Join(h.cfg.DataDir, "volumes", uuid)
	rnd := make([]byte, 40<<20) // > 2 delen van 16 MB, niet comprimeerbaar
	rand.New(rand.NewSource(2)).Read(rnd)
	if err := os.WriteFile(filepath.Join(vol, "world.bin"), rnd, 0o644); err != nil {
		t.Fatal(err)
	}
	rnd = nil
	if err := os.WriteFile(filepath.Join(vol, "server.properties"), []byte("motd=hoi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	progress := func() progressBody {
		t.Helper()
		var p progressBody
		h.expect("GET", "/api/servers/"+uuid+"/backups/progress", nil, 200).json(t, &p)
		return p
	}
	report := func(path string, n int) map[string]any {
		t.Helper()
		var rep map[string]any
		waitFor(t, "rapport "+path, 120*time.Second, func() bool {
			c := h.panel.Calls(path)
			if len(c) < n {
				return false
			}
			rep = c[n-1].Body
			return true
		})
		return rep
	}

	if p := progress(); p.Progress != nil {
		t.Fatalf("niets loopt, toch voortgang: %+v", p.Progress)
	}
	ws := h.ws(uuid, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: uuid, Permissions: []string{"console.read"}})})
	ws.next("auth_success", 5*time.Second, ev("auth_success"))

	// 1. Backup via de trage S3: voortgang zichtbaar, dan annuleren.
	key1 := "servers/" + uuid + "/1.tar.zst"
	h.expect("POST", "/api/servers/"+uuid+"/backups", map[string]any{"backup_id": 1, "s3": s3(slow), "key": key1, "databases": []any{}}, 202)
	h.expect("POST", "/api/servers/"+uuid+"/backups", map[string]any{"backup_id": 2, "s3": s3(slow), "key": "x", "databases": []any{}}, 409)
	var seen progressBody
	waitFor(t, "voortgang met ETA", 30*time.Second, func() bool {
		seen = progress()
		p := seen.Progress
		return p != nil && p.Phase == "archiving" && p.Bytes > 0 && p.EtaSeconds != nil
	})
	p := seen.Progress
	if p.BackupID != 1 || p.Operation != "backup" || p.TotalBytes < 40<<20 || p.Percent < 0 || p.Percent > 99 || !p.Cancellable || p.StartedAt == "" {
		t.Fatalf("voortgang: %+v", p)
	}
	msg := ws.next("backup_progress met fase", 5*time.Second, func(m map[string]any) bool {
		return m["event"] == "backup_progress" && m["phase"] == "archiving" && m["total_bytes"] != nil
	})
	if msg["operation"] != "backup" || msg["backup_id"] != float64(1) {
		t.Fatalf("websocket: %v", msg)
	}
	h.expect("POST", "/api/servers/"+uuid+"/backups/2/cancel", nil, 404) // ander id
	h.expect("POST", "/api/servers/"+uuid+"/backups/1/cancel", nil, 202)
	rep := report("/api/remote/backups/1", 1)
	if rep["successful"] != false || rep["error"] != "cancelled" {
		t.Fatalf("verwacht geannuleerd: %v", rep)
	}
	ws.next("backup_progress cancelled", 5*time.Second, func(m map[string]any) bool {
		return m["event"] == "backup_progress" && m["phase"] == "cancelled"
	})
	if _, err := mc.StatObject(ctx, "backups", key1, minio.StatObjectOptions{}); err == nil {
		t.Fatal("object van de geannuleerde backup staat nog in S3")
	}
	waitFor(t, "job weg", 5*time.Second, func() bool { return progress().Progress == nil })
	h.expect("POST", "/api/servers/"+uuid+"/backups/1/cancel", nil, 404)

	// 2. Gewone backup (snel) als bron voor het herstel.
	key3 := "servers/" + uuid + "/3.tar.zst"
	h.expect("POST", "/api/servers/"+uuid+"/backups", map[string]any{"backup_id": 3, "s3": s3(s3Addr), "key": key3, "databases": []any{}}, 202)
	rep = report("/api/remote/backups/3", 1)
	if rep["successful"] != true {
		t.Fatalf("backup mislukt: %v", rep)
	}
	ws.next("backup_progress done", 5*time.Second, func(m map[string]any) bool {
		return m["event"] == "backup_progress" && m["backup_id"] == float64(3) && m["phase"] == "done" && m["percent"] == float64(100)
	})
	sha := rep["sha256"].(string)

	// 3. Herstel via de trage S3, annuleren tijdens het downloaden: de data blijft zoals hij was.
	if err := os.WriteFile(filepath.Join(vol, "server.properties"), []byte("motd=veranderd\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := dirTree(t, vol)
	h.expect("POST", "/api/servers/"+uuid+"/backups/3/restore", map[string]any{"s3": s3(slow), "key": key3, "sha256": sha, "databases": []any{}}, 202)
	waitFor(t, "herstelvoortgang", 30*time.Second, func() bool {
		seen = progress()
		p := seen.Progress
		return p != nil && p.Phase == "downloading" && p.Bytes > 0 && p.TotalBytes > 0
	})
	if p := seen.Progress; p.Operation != "restore" || p.BackupID != 3 || !p.Cancellable {
		t.Fatalf("herstelvoortgang: %+v", p)
	}
	h.expect("POST", "/api/servers/"+uuid+"/backups/3/cancel", nil, 202)
	rep = report("/api/remote/backups/3/restore", 1)
	if rep["successful"] != false || rep["error"] != "cancelled" {
		t.Fatalf("verwacht geannuleerd herstel: %v", rep)
	}
	if got := dirTree(t, vol); fmt.Sprint(got) != fmt.Sprint(before) {
		t.Fatal("data veranderd na een geannuleerd herstel")
	}
	ents, _ := os.ReadDir(filepath.Dir(vol))
	for _, e := range ents {
		if e.Name() != uuid {
			t.Fatalf("tijdelijke map blijft staan: %s", e.Name())
		}
	}

	// 4. En een herstel zonder annuleren werkt nog.
	h.expect("POST", "/api/servers/"+uuid+"/backups/3/restore", map[string]any{"s3": s3(s3Addr), "key": key3, "sha256": sha, "databases": []any{}}, 202)
	rep = report("/api/remote/backups/3/restore", 2)
	if rep["successful"] != true {
		t.Fatalf("herstel mislukt: %v", rep)
	}
	if b, _ := os.ReadFile(filepath.Join(vol, "server.properties")); string(b) != "motd=hoi\n" {
		t.Fatalf("niet hersteld: %q", b)
	}
}
