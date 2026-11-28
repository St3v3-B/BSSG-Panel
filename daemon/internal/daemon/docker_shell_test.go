package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

// TestRealDockerShell: webterminal tegen echte Docker met alpine. De shell draait als 1000:1000 zonder
// capabilities, met read-only rootfs, alleen de serverdata gemount, op panel-site-<uuid>, en is na
// "exit" weg. Labels panel.test=true + panel.instance=devaccess-<pid>-…; opruimen filtert op beide.
func TestRealDockerShell(t *testing.T) {
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
	instance := fmt.Sprintf("devaccess-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	f := filters.NewArgs(filters.Arg("label", "panel.test=true"), filters.Arg("label", "panel.instance="+instance))
	t.Cleanup(func() {
		list, _ := cli.ContainerList(context.Background(), container.ListOptions{All: true, Filters: f})
		for _, c := range list {
			_ = cli.ContainerRemove(context.Background(), c.ID, container.RemoveOptions{Force: true})
		}
		nets, _ := cli.NetworkList(context.Background(), network.ListOptions{Filters: f})
		for _, n := range nets {
			_ = cli.NetworkRemove(context.Background(), n.ID)
		}
	})
	uuid := randUUID()
	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance)
	h.expect("POST", "/api/servers", map[string]any{
		"uuid": uuid, "type": "game", "image": "alpine:3.20", "startup": "sleep 1000",
		"stop":        map[string]string{"type": "signal", "value": "SIGTERM"},
		"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 100, "pids": 64},
		"allocations": []map[string]any{}, "skip_install": true,
		"install":     map[string]string{"image": "alpine:3.20", "script": "true"},
		"environment": map[string]string{"GREETING": "hoi"},
	}, 202)
	vol := filepath.Join(h.cfg.DataDir, "volumes", uuid)
	if err := os.WriteFile(filepath.Join(vol, "bestaand.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Lchown(filepath.Join(vol, "bestaand.txt"), 1000, 1000)

	c := h.term(uuid)
	c.json(map[string]any{"event": "auth", "token": h.termToken(uuid), "cols": 100, "rows": 30})
	c.waitEvent("auth_success", 60*time.Second)

	list, err := cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", "panel.instance="+instance), filters.Arg("label", "panel.role=shell"))})
	if err != nil || len(list) != 1 {
		t.Fatalf("shell-containers: %v %d", err, len(list))
	}
	insp, err := cli.ContainerInspect(ctx, list[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	hc := insp.HostConfig
	if insp.Config.User != "1000:1000" || !insp.Config.Tty || !hc.ReadonlyRootfs || !slices.Contains(hc.CapDrop, "ALL") || !slices.Contains(hc.SecurityOpt, "no-new-privileges") || hc.Privileged {
		t.Fatalf("beveiliging: user=%s tty=%v ro=%v capdrop=%v secopt=%v", insp.Config.User, insp.Config.Tty, hc.ReadonlyRootfs, hc.CapDrop, hc.SecurityOpt)
	}
	if string(hc.NetworkMode) != server.SiteNetwork(uuid) || hc.Memory != 64*1024*1024 {
		t.Fatalf("netwerk/geheugen: %s %d", hc.NetworkMode, hc.Memory)
	}
	for _, m := range insp.Mounts {
		if m.Destination != "/home/container" || strings.Contains(m.Source, "docker.sock") {
			t.Fatalf("mount %+v", m)
		}
	}
	if insp.Config.Labels["panel.server_uuid"] != uuid || insp.Config.Labels["panel.managed"] != "true" {
		t.Fatalf("labels %v", insp.Config.Labels)
	}

	c.input("echo UID=$(id -u) G=$GREETING; cat bestaand.txt; echo; touch gemaakt.txt && echo MADE; touch /etc/x || echo ROFS; ls /var/run/docker.sock || echo NOSOCK\r")
	c.waitOut("UID=1000 G=hoi", 30*time.Second)
	c.waitOut("data", 5*time.Second)
	c.waitOut("MADE", 5*time.Second)
	c.waitOut("ROFS", 5*time.Second)
	c.waitOut("NOSOCK", 5*time.Second)
	if _, err := os.Stat(filepath.Join(vol, "gemaakt.txt")); err != nil {
		t.Fatal("bestand niet in de serverdata:", err)
	}
	c.input("exit\r")
	c.waitEvent("terminal_exit", 15*time.Second)
	c.waitClosed(10 * time.Second)
	waitFor(t, "shell-container weg", 20*time.Second, func() bool {
		l, _ := cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", "panel.instance="+instance), filters.Arg("label", "panel.role=shell"))})
		return len(l) == 0
	})
}
