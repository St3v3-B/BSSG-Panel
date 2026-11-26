package daemon

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
	"panel/daemon/internal/testpanel"
)

// TestRealDocker draait de hele flow met alpine-containers tegen echte Docker:
// installeren → starten → console → commando → stop → daemon-herstart → console.
// Alles krijgt panel.test=true en een eigen panel.instance, en wordt opgeruimd.
// Overslaan met PANEL_SKIP_DOCKER_TESTS=1 of als Docker niet bereikbaar is.
func TestRealDocker(t *testing.T) {
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
	instance := fmt.Sprintf("daemon-test-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
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
	})

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance)
	sp := map[string]any{
		"uuid": u1, "type": "game", "image": "alpine:3.20",
		"startup": `echo "booting {{SERVER_UUID}} op {{SERVER_PORT}}"; sleep 0.3; echo "Server ready"; ` +
			`while read line; do echo "echo: $line"; if [ "$line" = stop ]; then echo bye; exit 0; fi; done`,
		"stop":          map[string]string{"type": "command", "value": "stop"},
		"ready_pattern": "^Server ready$",
		"environment":   map[string]string{"GREETING": "hoi"},
		"limits":        map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 100, "pids": 64},
		"allocations":   []map[string]any{{"ip": "127.0.0.1", "port": port, "primary": true}},
		"install": map[string]string{"image": "alpine:3.20", "script": "#!/bin/sh\nset -e\ncd /home/container\n" +
			"echo \"install als $(id -u) met $GREETING\"\necho data > installed.txt\nmkdir -p sub && touch sub/a"},
		"config_files":     []map[string]any{{"path": "test.properties", "format": "properties", "set": map[string]string{"port": "{{SERVER_PORT}}"}}},
		"start_on_install": true,
	}
	h.expect("POST", "/api/servers", sp, 202)
	ws := h.ws(u1, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read", "console.write", "power"}})})
	ws.next("auth_success", 5*time.Second, ev("auth_success"))
	ws.next("install-uitvoer", 60*time.Second, lineMatch("install_output", "install als 0 met hoi"))
	h.waitState(u1, "online", 60*time.Second)

	vol := filepath.Join(h.cfg.DataDir, "volumes", u1)
	for _, f := range []string{"installed.txt", "sub/a", "test.properties"} {
		fi, err := os.Stat(filepath.Join(vol, f))
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); st.Uid != 1000 || st.Gid != 1000 {
			t.Errorf("%s: eigenaar %d:%d", f, st.Uid, st.Gid)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(vol, "test.properties")); string(b) != "port="+strconv.Itoa(port)+"\n" {
		t.Fatalf("%q", b)
	}

	insp, err := cli.ContainerInspect(ctx, server.ContainerName(u1))
	if err != nil {
		t.Fatal(err)
	}
	hc := insp.HostConfig
	if insp.Config.User != "1000:1000" || !hc.ReadonlyRootfs || len(hc.CapDrop) != 1 || hc.CapDrop[0] != "ALL" ||
		hc.Memory != 64<<20 || hc.MemorySwap != 64<<20 || hc.NanoCPUs != 5e8 || hc.PidsLimit == nil || *hc.PidsLimit != 64 ||
		insp.Config.Labels["panel.role"] != "server" || insp.Config.Labels["panel.instance"] != instance {
		t.Fatalf("container: user=%s ro=%v cap=%v mem=%d swap=%d cpu=%d labels=%v", insp.Config.User, hc.ReadonlyRootfs, hc.CapDrop, hc.Memory, hc.MemorySwap, hc.NanoCPUs, insp.Config.Labels)
	}
	if b := hc.PortBindings["0/tcp"]; b != nil {
		t.Fatal("onverwachte poort")
	}
	if b := hc.PortBindings[natPort(port, "udp")]; len(b) != 1 || b[0].HostIP != "127.0.0.1" {
		t.Fatal(hc.PortBindings)
	}

	ws.next("console booting", 5*time.Second, lineMatch("console_output", "booting "+u1))
	ws.send(map[string]any{"event": "send_command", "command": "hallo"})
	ws.next("echo", 5*time.Second, lineMatch("console_output", "echo: hallo"))
	st := ws.next("stats", 10*time.Second, func(m map[string]any) bool { return m["event"] == "stats" && m["memory_bytes"].(float64) > 0 })
	if st["memory_limit_bytes"].(float64) != 64<<20 {
		t.Fatal(st)
	}

	// daemon herstarten: container blijft draaien, console pakt het weer op
	h.stop()
	if insp, _ := cli.ContainerInspect(ctx, server.ContainerName(u1)); !insp.State.Running {
		t.Fatal("container gestopt door daemon-stop")
	}
	h.start()
	h.waitState(u1, "online", 10*time.Second)
	ws2 := h.ws(u1, nil)
	ws2.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read", "console.write"}})})
	ws2.next("backlog na herstart", 5*time.Second, lineMatch("console_output", "echo: hallo"))
	ws2.send(map[string]any{"event": "send_command", "command": "terug"})
	ws2.next("echo na herstart", 5*time.Second, lineMatch("console_output", "echo: terug"))

	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 20*time.Second)
	ws2.next("bye", 5*time.Second, lineMatch("console_output", "bye"))
	if insp, _ := cli.ContainerInspect(ctx, server.ContainerName(u1)); insp.State.Running || insp.State.ExitCode != 0 {
		t.Fatalf("na stop: running=%v exit=%d", insp.State.Running, insp.State.ExitCode)
	}

	h.expect("DELETE", "/api/servers/"+u1, nil, 204)
	if _, err := cli.ContainerInspect(ctx, server.ContainerName(u1)); err == nil {
		t.Fatal("container bestaat nog")
	}
	if _, err := os.Stat(vol); !os.IsNotExist(err) {
		t.Fatal("data bestaat nog")
	}
}

func natPort(p int, proto string) nat.Port {
	return nat.Port(strconv.Itoa(p) + "/" + proto)
}
