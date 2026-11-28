package daemon

import (
	"context"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"

	"panel/daemon/internal/engine"
)

// TestAllocationProtocols: protocol per allocation → Docker-poortbindingen (leeg/both = tcp + udp).
func TestAllocationProtocols(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", nil, "")
	sp := testSpec(u1)
	sp["start_on_install"] = true
	sp["allocations"] = []map[string]any{
		{"ip": "127.0.0.1", "port": 2456, "primary": true, "protocol": "udp"},
		{"ip": "127.0.0.1", "port": 2457, "protocol": "udp"},
		{"ip": "127.0.0.1", "port": 2458, "protocol": "tcp"},
		{"ip": "127.0.0.1", "port": 2459, "protocol": "both"},
		{"ip": "127.0.0.1", "port": 2460},
	}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	var got []string
	for _, p := range eng.Container("panel-" + u1).Config.Ports {
		if p.HostPort != p.ContainerPort || p.HostIP != "127.0.0.1" {
			t.Fatalf("binding %+v", p)
		}
		got = append(got, fmt.Sprintf("%d/%s", p.HostPort, p.Proto))
	}
	sort.Strings(got)
	want := "2456/udp 2457/udp 2458/tcp 2459/tcp 2459/udp 2460/tcp 2460/udp"
	if strings.Join(got, " ") != want {
		t.Fatalf("bindingen %v, verwacht %s", got, want)
	}

	bad := testSpec("0b7c2d1e-dddd-4222-8333-000000000004")
	bad["allocations"] = []map[string]any{{"ip": "127.0.0.1", "port": 2461, "protocol": "sctp"}}
	h.expect("POST", "/api/servers", bad, 400)
	bad["allocations"] = []map[string]any{{"ip": "127.0.0.1", "port": 2461}}
	bad["stop"] = map[string]any{"type": "signal", "value": "SIGINT", "timeout_seconds": 2}
	h.expect("POST", "/api/servers", bad, 400)
}

// TestStopTimeoutFromSpec: stop.timeout_seconds gaat voor de standaard van de daemon (3 s in de harness).
func TestStopTimeoutFromSpec(t *testing.T) {
	eng := engine.NewFake()
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		c.Println("Done (0.1s)!")
		<-c.Exited() // negeert stop
	}
	h := newHarness(t, eng, nil, nil, "", nil, "")
	sp := testSpec(u1)
	sp["start_on_install"] = true
	sp["stop"] = map[string]any{"type": "command", "value": "stop", "timeout_seconds": 5}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	start := time.Now()
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 8*time.Second)
	if d := time.Since(start); d < 4500*time.Millisecond {
		t.Fatalf("na %v gekilld; verwacht na 5 s", d)
	}
}

// TestRealDockerUDPPort: een allocation met protocol udp wordt alleen als UDP gepubliceerd en een
// datagram bereikt de container (busybox nc).
func TestRealDockerUDPPort(t *testing.T) {
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
	instance := fmt.Sprintf("daemon-udp-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
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
	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, nil)
	u := randUUID()
	port := freeUDPPort(t)
	sp := map[string]any{
		"uuid": u, "type": "game", "image": "alpine:3.20",
		"startup":       "echo ready; exec nc -u -l -p {{SERVER_PORT}}",
		"stop":          map[string]any{"type": "signal", "value": "SIGTERM", "timeout_seconds": 5},
		"ready_pattern": "^ready$", "environment": map[string]string{},
		"limits":       map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 0},
		"allocations":  []map[string]any{{"ip": "127.0.0.1", "port": port, "primary": true, "protocol": "udp"}},
		"skip_install": true, "start_on_install": true,
		"install": map[string]string{"image": "alpine:3.20", "script": "true"},
	}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u, "online", 60*time.Second)
	insp, err := cli.ContainerInspect(context.Background(), "panel-"+u)
	if err != nil {
		t.Fatal(err)
	}
	var bound []string
	for p := range insp.HostConfig.PortBindings {
		bound = append(bound, string(p))
	}
	if want := fmt.Sprintf("%d/udp", port); len(bound) != 1 || bound[0] != want {
		t.Fatalf("bindingen %v, verwacht alleen %s", bound, want)
	}
	c, err := net.Dial("udp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	waitFor(t, "UDP-datagram in de console", 20*time.Second, func() bool {
		_, _ = c.Write([]byte("hallo-udp\n"))
		var l struct{ Lines []string }
		h.expect("GET", "/api/servers/"+u+"/logs?lines=50", nil, 200).json(t, &l)
		for _, line := range l.Lines {
			if strings.Contains(line, "hallo-udp") {
				return true
			}
		}
		return false
	})
	h.expect("DELETE", "/api/servers/"+u, nil, 204)
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}
