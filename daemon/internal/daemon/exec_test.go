package daemon

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
)

type execOut struct {
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
	Truncated  bool   `json:"truncated"`
	TimedOut   bool   `json:"timed_out"`
	DurationMs int    `json:"duration_ms"`
}

func webSpec(uuid, image, startup string) map[string]any {
	return map[string]any{
		"uuid": uuid, "type": "web", "image": image, "http_port": 8080,
		"startup": startup, "stop": map[string]string{"type": "signal", "value": "SIGKILL"},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 50},
		"allocations": []any{}, "skip_install": true,
		"install": map[string]string{"image": image, "script": "true"},
	}
}

func TestExecEndpointFake(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, "")
	site := randUUID()
	sp := webSpec(site, "alpine:3.20", "echo ready; sleep 600")
	sp["ready_pattern"] = `Done \(`
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(site, "offline", 5*time.Second)
	game := testSpec(u1)
	h.expect("POST", "/api/servers", game, 202)
	h.waitState(u1, "offline", 5*time.Second)

	path := "/api/servers/" + site + "/exec"
	if r := h.doTok("POST", path, map[string]any{"command": "id"}, ""); r.Code != 401 {
		t.Fatalf("zonder token: %d", r.Code)
	}
	h.expect("POST", path, map[string]any{"command": "id"}, 409) // draait niet
	h.expect("POST", "/api/servers/"+site+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(site, "online", 5*time.Second)

	eng.ExecHandler = func(_ string, o engine.ExecOptions) (engine.ExecResult, error) {
		return engine.ExecResult{ExitCode: 3, Output: "hallo", Truncated: true}, nil
	}
	var out execOut
	h.expect("POST", path, map[string]any{"command": "php wp-cron.php", "timeout_seconds": 30}, 200).json(t, &out)
	if out.ExitCode != 3 || out.Output != "hallo" || !out.Truncated || out.TimedOut {
		t.Fatalf("%+v", out)
	}
	ex := eng.Execs()
	if len(ex) != 1 {
		t.Fatal(ex)
	}
	// Altijd uid 1000 (nooit root), vaste werkmap, timeout-wrapper, geen directe shell-string in argv[0].
	if ex[0].User != "1000:1000" || ex[0].WorkingDir != "/home/container" || ex[0].MaxOutput != 16*1024 ||
		!slices.Equal(ex[0].Cmd, []string{"timeout", "-s", "KILL", "30", "sh", "-c", "php wp-cron.php"}) {
		t.Fatalf("%+v", ex[0])
	}
	// Validatie.
	for _, b := range []map[string]any{
		{"command": ""}, {"command": "  "}, {"command": strings.Repeat("x", 2001)},
		{"command": "ls", "timeout_seconds": 601}, {"command": "ls", "timeout_seconds": -1},
	} {
		h.expect("POST", path, b, 400)
	}
	// Alleen websites.
	h.expect("POST", "/api/servers/"+u1+"/exec", map[string]any{"command": "ls"}, 400)
	h.expect("POST", "/api/servers/"+randUUID()+"/exec", map[string]any{"command": "ls"}, 404)
}

// TestRealDockerExec: uid 1000, werkmap, uitvoercap en timeout in een echte container.
func TestRealDockerExec(t *testing.T) {
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
	if err := eng.EnsureImage(ctx, "alpine:3.20", nil); err != nil {
		t.Fatal(err)
	}
	instance := fmt.Sprintf("daemon-exec-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
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
	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance)
	site := randUUID()
	h.expect("POST", "/api/servers", webSpec(site, "alpine:3.20", "echo ready; sleep 3600"), 202)
	h.expect("POST", "/api/servers/"+site+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(site, "online", 60*time.Second)
	_ = server.ContainerName
	run := func(cmd string, secs int) execOut {
		var o execOut
		h.expect("POST", "/api/servers/"+site+"/exec", map[string]any{"command": cmd, "timeout_seconds": secs}, 200).json(t, &o)
		return o
	}
	if o := run("id -u; id -g; pwd; echo err >&2; exit 7", 10); o.ExitCode != 7 || o.Output != "1000\n1000\n/home/container\nerr\n" {
		t.Fatalf("%+v", o)
	}
	// Schrijven buiten /home/container en /tmp mag niet (read-only rootfs, geen root).
	if o := run("touch /etc/x", 10); o.ExitCode == 0 {
		t.Fatalf("schrijven in /etc: %+v", o)
	}
	o := run("head -c 40000 /dev/zero | tr '\\0' x", 10)
	if !o.Truncated || len(o.Output) != server.ExecOutputMax || o.ExitCode != 0 {
		t.Fatalf("cap: trunc=%v len=%d exit=%d", o.Truncated, len(o.Output), o.ExitCode)
	}
	start := time.Now()
	o = run("sleep 30", 1)
	if !o.TimedOut || o.ExitCode != -1 || time.Since(start) > 8*time.Second {
		t.Fatalf("timeout: %+v na %v", o, time.Since(start))
	}
}
