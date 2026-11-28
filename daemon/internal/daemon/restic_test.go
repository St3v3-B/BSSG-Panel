package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"

	"panel/daemon/internal/backup"
	"panel/daemon/internal/engine"
)

// TestRealDockerRestic draait de echte restic-container tegen een lokale repository in een
// tijdelijke map (geen S3 nodig): backup, incrementele backup met retentie, bladeren, losse
// bestanden terugzetten (op hun plek en in een submap), volledig herstel en forget.
func TestRealDockerRestic(t *testing.T) {
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
	for _, img := range []string{backup.DefaultResticImage, "alpine:3.20"} {
		if err := eng.EnsureImage(ctx, img, nil); err != nil {
			t.Skip("image niet beschikbaar:", img, err)
		}
	}
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	instance := fmt.Sprintf("restic-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
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
	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, nil)
	h.d.backup.ResticLocalRepo = t.TempDir()
	uuid := randUUID()
	h.expect("POST", "/api/servers", map[string]any{
		"uuid": uuid, "type": "web", "image": "alpine:3.20", "http_port": 8080,
		"startup": "sleep 600", "stop": map[string]string{"type": "signal", "value": "SIGKILL"},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 0},
		"allocations": []any{}, "skip_install": true,
		"install": map[string]string{"image": "alpine:3.20", "script": "true"},
	}, 202)
	vol := filepath.Join(h.cfg.DataDir, "volumes", uuid)
	write := func(rel, content string) {
		p := filepath.Join(vol, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(vol, rel))
		if err != nil {
			return "<missing>"
		}
		return string(b)
	}
	write("server.properties", "motd=one")
	write("world/level.dat", "level-1")
	write("world/region/r.0.0.mca", "region-1")
	write("we*ird [1].txt", "weird")
	write("logs/latest.log", "skip")
	write(".panel-deploy/x", "skip")

	repo := map[string]any{
		"s3":       map[string]any{"endpoint": "https://s3.node1.test", "bucket": "bk", "region": "us-east-1", "access_key": "AKTEST", "secret_key": "SKTEST-secret-1", "path_style": true},
		"password": "repo-password-0123456789abcdef",
	}
	with := func(extra map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range repo {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	report := func(path string) map[string]any {
		var body map[string]any
		waitFor(t, path, 120*time.Second, func() bool {
			for _, c := range h.panel.Calls(path) {
				if c.Path == path {
					body = c.Body
				}
			}
			return body != nil
		})
		return body
	}
	base := "/api/servers/" + uuid + "/restic"

	// Eerste backup (maakt de repository aan).
	h.expect("POST", base+"/backups", with(map[string]any{"backup_id": 1, "ignore": []string{"/.panel-deploy", "logs/*"}, "databases": []any{}}), 202)
	r1 := report("/api/remote/backups/1")
	if r1["successful"] != true {
		t.Fatalf("backup 1: %v", r1)
	}
	snap1, _ := r1["snapshot_id"].(string)
	if !backup.ValidSnapshotID(snap1) || r1["size_bytes"].(float64) <= 0 || r1["added_bytes"].(float64) <= 0 {
		t.Fatalf("backup 1: %v", r1)
	}
	if strings.Contains(fmt.Sprint(r1), "repo-password") {
		t.Fatal("wachtwoord in rapport")
	}
	// Er loopt niets meer; een tweede tegelijk kan niet (409) zolang er wel iets loopt — hier niet.
	h.expect("GET", "/api/servers/"+uuid+"/backups/progress", nil, 200)

	// Tweede backup met retentie: keep_last 1 met prune.
	write("server.properties", "motd=two")
	h.expect("POST", base+"/backups", with(map[string]any{"backup_id": 2, "ignore": []string{"/.panel-deploy", "logs/*"}, "databases": []any{}, "retention": map[string]any{"keep_last": 1, "keep_daily": 0, "keep_weekly": 0}, "prune": true}), 202)
	r2 := report("/api/remote/backups/2")
	if r2["successful"] != true || r2["pruned"] != true {
		t.Fatalf("backup 2: %v", r2)
	}
	if f, _ := r2["forgotten_snapshots"].([]any); len(f) != 1 || f[0] != snap1 {
		t.Fatalf("forgotten: %v (snap1 %s)", r2["forgotten_snapshots"], snap1)
	}
	snap2 := r2["snapshot_id"].(string)
	if r2["added_bytes"].(float64) >= r1["added_bytes"].(float64) {
		t.Errorf("tweede backup niet incrementeel: %v vs %v", r2["added_bytes"], r1["added_bytes"])
	}

	// Bladeren.
	var ls struct {
		Entries   []backup.LsEntry `json:"entries"`
		Truncated bool             `json:"truncated"`
	}
	h.expect("POST", base+"/ls", with(map[string]any{"snapshot_id": snap2, "path": "/"}), 200).json(t, &ls)
	names := []string{}
	for _, e := range ls.Entries {
		names = append(names, e.Type+":"+e.Path)
	}
	if got := strings.Join(names, ","); got != "dir:logs,dir:world,file:server.properties,file:we*ird [1].txt" {
		t.Errorf("ls /: %s", got)
	}
	h.expect("POST", base+"/ls", with(map[string]any{"snapshot_id": snap2, "path": "world"}), 200).json(t, &ls)
	if len(ls.Entries) != 2 || ls.Entries[0].Path != "world/region" || ls.Entries[1].Path != "world/level.dat" || ls.Entries[1].Size != 7 {
		t.Errorf("ls world: %+v", ls.Entries)
	}
	h.expect("POST", base+"/ls", with(map[string]any{"snapshot_id": snap2, "path": "../etc"}), 400)
	h.expect("POST", base+"/ls", with(map[string]any{"snapshot_id": "../x", "path": "/"}), 400)

	// Losse paden terugzetten, op hun plek.
	write("world/level.dat", "broken")
	_ = os.Remove(filepath.Join(vol, "we*ird [1].txt"))
	write("world/extra.dat", "stays")
	h.expect("POST", base+"/backups/3/restore", with(map[string]any{"snapshot_id": snap2, "databases": []any{}, "paths": []string{"world/level.dat", "/we*ird [1].txt"}}), 202)
	if r := report("/api/remote/backups/3/restore"); r["successful"] != true {
		t.Fatalf("restore paden: %v", r)
	}
	if read("world/level.dat") != "level-1" || read("we*ird [1].txt") != "weird" || read("world/extra.dat") != "stays" {
		t.Errorf("na herstel: %q %q %q", read("world/level.dat"), read("we*ird [1].txt"), read("world/extra.dat"))
	}
	// Naar een submap.
	h.expect("POST", base+"/backups/4/restore", with(map[string]any{"snapshot_id": snap2, "databases": []any{}, "paths": []string{"world"}, "destination": "restore-2026-11-28"}), 202)
	if r := report("/api/remote/backups/4/restore"); r["successful"] != true {
		t.Fatalf("restore submap: %v", r)
	}
	if read("restore-2026-11-28/world/region/r.0.0.mca") != "region-1" || read("restore-2026-11-28/world/extra.dat") != "<missing>" {
		t.Error("submap-herstel klopt niet")
	}
	// Pad buiten de data of niet in de snapshot.
	h.expect("POST", base+"/backups/5/restore", with(map[string]any{"snapshot_id": snap2, "databases": []any{}, "paths": []string{"../../etc"}}), 400)
	h.expect("POST", base+"/backups/6/restore", with(map[string]any{"snapshot_id": snap2, "databases": []any{}, "paths": []string{"nope.txt"}}), 202)
	if r := report("/api/remote/backups/6/restore"); r["successful"] != false || !strings.Contains(fmt.Sprint(r["error"]), "none of the selected paths") {
		t.Errorf("niet-bestaand pad: %v", r)
	}

	// Volledig herstel: alles terug naar snapshot 2 (extra bestanden weg).
	write("junk.txt", "junk")
	h.expect("POST", base+"/backups/7/restore", with(map[string]any{"snapshot_id": snap2, "databases": []any{}}), 202)
	if r := report("/api/remote/backups/7/restore"); r["successful"] != true {
		t.Fatalf("volledig herstel: %v", r)
	}
	if read("junk.txt") != "<missing>" || read("server.properties") != "motd=two" || read("world/region/r.0.0.mca") != "region-1" || read(".panel-deploy/x") != "<missing>" {
		t.Errorf("na volledig herstel: junk=%q props=%q", read("junk.txt"), read("server.properties"))
	}
	if fi, err := os.Stat(vol); err != nil || !fi.IsDir() {
		t.Fatal("volume weg")
	}

	// Forget (ook van een snapshot die al weg is).
	h.expect("POST", base+"/forget", with(map[string]any{"snapshot_ids": []string{snap2, snap1}}), 204)
	h.expect("POST", base+"/ls", with(map[string]any{"snapshot_id": snap2, "path": "/"}), 500)

	// Geen restic-containers achtergebleven.
	f := filters.NewArgs(filters.Arg("label", "panel.test=true"), filters.Arg("label", "panel.instance="+instance), filters.Arg("label", "panel.role=install"))
	if list, _ := cli.ContainerList(ctx, container.ListOptions{All: true, Filters: f}); len(list) != 0 {
		t.Errorf("%d tijdelijke containers over", len(list))
	}
}
