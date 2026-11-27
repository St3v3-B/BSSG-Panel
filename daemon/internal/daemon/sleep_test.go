package daemon

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/mcproto"
	"panel/daemon/internal/testpanel"
)

func freePort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func mcLogin(t *testing.T, addr string) string {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	_ = mcproto.WritePacket(c, 0, mcproto.AppendHandshake(nil, mcproto.Handshake{Protocol: 767, Address: "x", Port: 1, NextState: 2}))
	id, p, err := mcproto.ReadPacket(bufio.NewReader(c), 1<<16)
	if err != nil || id != 0 {
		t.Fatal("disconnect", err, id)
	}
	return string(p)
}

func TestSleepMode(t *testing.T) {
	var players atomic.Int32
	players.Store(1)
	var pinged atomic.Value
	mut := func(_ *config.Config, d *Deps) {
		d.Server.SleepMinute = 50 * time.Millisecond
		d.Server.Pinger = func(_ context.Context, addr string) (int, error) {
			pinged.Store(addr)
			return int(players.Load()), nil
		}
	}
	dir := t.TempDir()
	h := newHarnessWith(t, engine.NewFake(), nil, nil, dir, nil, "", mut)
	port := freePort(t)
	sp := testSpec(u1)
	sp["allocations"] = []map[string]any{{"ip": "127.0.0.1", "port": port, "primary": true}}
	sp["config_files"] = []any{}
	sp["sleep"] = map[string]any{"idle_minutes": 2, "kick_message": "wordt gestart"}
	sp["start_on_install"] = true
	bad := testSpec(u1)
	bad["sleep"] = map[string]any{"idle_minutes": 0}
	h.expect("POST", "/api/servers", bad, 400)
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	time.Sleep(300 * time.Millisecond)
	if h.state(u1).State != "online" {
		t.Fatal("slaapt terwijl er spelers zijn")
	}
	if a, _ := pinged.Load().(string); a != net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) {
		t.Fatal("ping-adres", a)
	}
	players.Store(0)
	h.waitState(u1, "sleeping", 3*time.Second)
	waitFor(t, "status naar panel", 2*time.Second, func() bool {
		s := h.panel.Statuses(u1)
		return s[len(s)-1] == "sleeping"
	})
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	waitFor(t, "listener", 3*time.Second, func() bool {
		c, err := net.Dial("tcp", addr)
		if err == nil {
			c.Close()
		}
		return err == nil
	})
	n, err := mcproto.Ping(context.Background(), addr)
	if err != nil || n != 0 || h.state(u1).State != "sleeping" {
		t.Fatal("status-ping", n, err)
	}

	// Daemon-herstart: weer sleeping met listener.
	h.restart()
	if h.state(u1).State != "sleeping" {
		t.Fatal("na herstart", h.state(u1).State)
	}
	waitFor(t, "listener na herstart", 5*time.Second, func() bool { _, err := mcproto.Ping(context.Background(), addr); return err == nil })

	// Login → disconnect met kick_message en de server start.
	players.Store(1)
	if msg := mcLogin(t, addr); !strings.Contains(msg, "wordt gestart") {
		t.Fatal(msg)
	}
	h.waitState(u1, "online", 5*time.Second)
	if c, err := net.Dial("tcp", addr); err == nil {
		c.Close()
		t.Fatal("listener nog open terwijl de server draait")
	}

	// Handmatige stop → offline, geen listener; start vanuit sleeping via ws werkt.
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 5*time.Second)
	time.Sleep(200 * time.Millisecond)
	if _, err := mcproto.Ping(context.Background(), addr); err == nil {
		t.Fatal("listener na handmatige stop")
	}
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	players.Store(0)
	h.waitState(u1, "sleeping", 3*time.Second)
	ws := h.ws(u1, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read", "power"}})})
	ws.next("auth_success", 2*time.Second, ev("auth_success"))
	players.Store(1)
	ws.send(map[string]any{"event": "set_state", "state": "start"})
	h.waitState(u1, "online", 5*time.Second)

	// Poort bezet tijdens slapen: nette melding en offline.
	occ, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer occ.Close()
	players.Store(0)
	ws.next("poort bezet", 10*time.Second, func(m map[string]any) bool {
		l, _ := m["line"].(string)
		return m["event"] == "daemon_message" && m["level"] == "warning" && strings.Contains(l, "in use")
	})
	h.waitState(u1, "offline", 2*time.Second)
}

// TestRealDockerSleep: poort vrijgeven tussen container en listener met echte docker-proxy.
func TestRealDockerSleep(t *testing.T) {
	if os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("PANEL_SKIP_DOCKER_TESTS=1")
	}
	eng, err := engine.NewDocker()
	if err != nil {
		t.Skip("geen Docker:", err)
	}
	if _, err := eng.Version(context.Background()); err != nil {
		t.Skip("geen Docker:", err)
	}
	instance := fmt.Sprintf("daemon-sleep-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
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
	var players atomic.Int32
	players.Store(1)
	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, func(_ *config.Config, d *Deps) {
		d.Server.SleepMinute = 200 * time.Millisecond
		d.Server.Pinger = func(context.Context, string) (int, error) { return int(players.Load()), nil }
	})
	u := randUUID()
	port := freePort(t)
	sp := map[string]any{
		"uuid": u, "type": "game", "image": "alpine:3.20",
		"startup": "echo ready; exec sleep 600", "stop": map[string]string{"type": "signal", "value": "SIGTERM"},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":       map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 0},
		"allocations":  []map[string]any{{"ip": "127.0.0.1", "port": port, "primary": true}},
		"skip_install": true, "start_on_install": true,
		"install": map[string]string{"image": "alpine:3.20", "script": "true"},
		"sleep":   map[string]any{"idle_minutes": 1},
	}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u, "online", 60*time.Second)
	players.Store(0)
	h.waitState(u, "sleeping", 20*time.Second)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	waitFor(t, "listener", 10*time.Second, func() bool { _, err := mcproto.Ping(context.Background(), addr); return err == nil })
	players.Store(1)
	if msg := mcLogin(t, addr); !strings.Contains(msg, "starting") {
		t.Fatal(msg)
	}
	h.waitState(u, "online", 30*time.Second)
	insp, err := cli.ContainerInspect(context.Background(), "panel-"+u)
	if err != nil || !insp.State.Running {
		t.Fatal("container draait niet na wekken", err)
	}
	h.expect("DELETE", "/api/servers/"+u, nil, 204)
}
