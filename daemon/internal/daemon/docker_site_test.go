package daemon

import (
	"context"
	"crypto/rand"
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

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
	"panel/daemon/internal/testpanel"
)

// TestRealDockerSiteAndDisk: website op een eigen intern netwerk met (nep-)MariaDB eraan,
// en de softe disk-limiet met dd in een echte container.
func TestRealDockerSiteAndDisk(t *testing.T) {
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
	instance := fmt.Sprintf("daemon-site-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
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
	// Nep-MariaDB (eigen naam, nooit de echte panel-mariadb).
	dbName := "panel-mariadb-" + instance
	if err := eng.EnsureImage(ctx, "alpine:3.20", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := cli.ContainerCreate(ctx, &container.Config{Image: "alpine:3.20", Cmd: []string{"sleep", "600"}, Labels: labels}, &container.HostConfig{}, nil, nil, dbName); err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, dbName, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}

	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, func(d *Deps) { d.Server.MariaDB = dbName })
	site := randUUID()
	sp := map[string]any{
		"uuid": site, "type": "web", "image": "alpine:3.20", "http_port": 8080,
		"startup":       `echo ready; while true; do printf 'HTTP/1.0 200 OK\r\n\r\nhoi' | nc -l -p 8080 >/dev/null; done`,
		"stop":          map[string]string{"type": "signal", "value": "SIGKILL"},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 10},
		"allocations": []any{}, "skip_install": true,
		"install": map[string]string{"image": "alpine:3.20", "script": "true"},
	}
	h.expect("POST", "/api/servers", sp, 202)
	h.expect("POST", "/api/servers/"+site+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(site, "online", 60*time.Second)
	netName := "panel-site-" + site
	ni, err := cli.NetworkInspect(ctx, netName, network.InspectOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !ni.Internal || ni.Labels["panel.role"] != "site" || ni.Labels["panel.instance"] != instance || ni.Labels["panel.managed"] != "true" {
		t.Fatalf("netwerk: internal=%v labels=%v", ni.Internal, ni.Labels)
	}
	members := map[string]bool{}
	for _, c := range ni.Containers {
		members[c.Name] = true
	}
	if !members[server.ContainerName(site)] || !members[dbName] {
		t.Fatalf("leden: %v", members)
	}
	// Vanaf de "MariaDB" is de site bereikbaar op zijn naam (zoals Caddy hem ziet).
	ex, err := cli.ContainerExecCreate(ctx, dbName, container.ExecOptions{Cmd: []string{"wget", "-qO-", "-T", "5", "http://" + server.ContainerName(site) + ":8080/"}, AttachStdout: true, AttachStderr: true})
	if err != nil {
		t.Fatal(err)
	}
	att, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4096)
	var out strings.Builder
	deadline := time.Now().Add(10 * time.Second)
	_ = att.Conn.SetReadDeadline(deadline)
	for {
		n, err := att.Reader.Read(buf)
		out.Write(buf[:n])
		if err != nil {
			break
		}
	}
	att.Close()
	if !strings.Contains(out.String(), "hoi") {
		t.Fatalf("site niet bereikbaar via het site-netwerk: %q", out.String())
	}
	h.expect("DELETE", "/api/servers/"+site, nil, 204)
	if _, err := cli.NetworkInspect(ctx, netName, network.InspectOptions{}); err == nil {
		t.Fatal("site-netwerk niet opgeruimd")
	}
	if c, err := cli.ContainerInspect(ctx, dbName); err != nil || !c.State.Running {
		t.Fatal("MariaDB aangeraakt", err)
	}

	// Disk-limiet: 2 MB, dd schrijft 3 MB.
	game := randUUID()
	gs := map[string]any{
		"uuid": game, "type": "game", "image": "alpine:3.20",
		"startup":       `echo ready; while read -r c; do [ "$c" = stop ] && exit 0; sh -c "$c"; done`,
		"stop":          map[string]string{"type": "command", "value": "stop"},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 2},
		"allocations": []any{}, "skip_install": true,
		"install": map[string]string{"image": "alpine:3.20", "script": "true"},
	}
	h.expect("POST", "/api/servers", gs, 202)
	h.expect("POST", "/api/servers/"+game+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(game, "online", 60*time.Second)
	ws := h.ws(game, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: game, Permissions: []string{"console.read", "console.write"}})})
	ws.next("auth_success", 5*time.Second, ev("auth_success"))
	ws.send(map[string]any{"event": "send_command", "command": "dd if=/dev/zero of=/home/container/groot.bin bs=1M count=3 2>&1; echo dd-klaar"})
	ws.next("waarschuwing", 10*time.Second, func(m map[string]any) bool { return m["event"] == "daemon_message" && m["level"] == "warning" })
	h.waitState(game, "disk_exceeded", 40*time.Second)
	h.expect("POST", "/api/servers/"+game+"/power", map[string]string{"action": "start"}, 409)
	if c, _, _ := h.raw("PUT", "/api/servers/"+game+"/files/contents?path=/x.txt", []byte("x")); c != 507 {
		t.Fatal(c)
	}
	h.expect("POST", "/api/servers/"+game+"/files/delete", map[string]any{"paths": []string{"/groot.bin"}}, 204)
	waitFor(t, "weer offline", 5*time.Second, func() bool { return h.state(game).State == "offline" })
	h.expect("POST", "/api/servers/"+game+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(game, "online", 30*time.Second)
	if fi, err := os.Stat(filepath.Join(h.cfg.DataDir, "volumes", game)); err != nil || !fi.IsDir() {
		t.Fatal(err)
	}
	h.expect("DELETE", "/api/servers/"+game, nil, 204)
}

func randUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
