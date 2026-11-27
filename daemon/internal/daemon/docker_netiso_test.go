package daemon

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
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

// TestRealDockerNetworkIsolation: twee game-servers (alpine) kunnen elkaar niet bereiken, ook
// niet een infra-container op een ander netwerk; een Velocity-proxy bereikt zijn backend op
// naam via panel-net-<proxy>, een server buiten dat netwerk niet. Gepubliceerde poorten werken
// vanaf de host, en uitgaand internet werkt (als de host zelf internet heeft).
func TestRealDockerNetworkIsolation(t *testing.T) {
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
	instance := fmt.Sprintf("daemon-netiso-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
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
	const img = "alpine:3.22"
	if err := eng.EnsureImage(ctx, img, nil); err != nil {
		t.Fatal(err)
	}

	// "Infra": een container op een eigen netwerk (zoals panel-backend/panel-db), luistert op 7000.
	infraNet, infraCtr := "it-infra-"+instance, "it-infra-"+instance
	if _, err := cli.NetworkCreate(ctx, infraNet, network.CreateOptions{Driver: "bridge", Labels: labels}); err != nil {
		t.Fatal(err)
	}
	if _, err := cli.ContainerCreate(ctx, &container.Config{Image: img, Labels: labels, Cmd: []string{"sh", "-c", "while true; do echo infra | nc -l -p 7000; done"}},
		&container.HostConfig{NetworkMode: container.NetworkMode(infraNet)}, nil, nil, infraCtr); err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, infraCtr, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}

	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, nil)
	type srv struct {
		uuid string
		port int
	}
	mk := func(word string) srv {
		t.Helper()
		s := srv{randUUID(), freePort(t)}
		sp := map[string]any{
			"uuid": s.uuid, "type": "game", "image": img,
			"startup":       fmt.Sprintf(`echo ready; while true; do echo %s | nc -l -p %d; done`, word, s.port),
			"stop":          map[string]string{"type": "signal", "value": "SIGKILL"},
			"ready_pattern": "^ready$", "environment": map[string]string{},
			"limits":      map[string]any{"cpu_pct": 50, "memory_mb": 64, "swap_mb": 0, "disk_mb": 10},
			"allocations": []map[string]any{{"ip": "127.0.0.1", "port": s.port, "primary": true}},
			"install":     map[string]string{"image": img, "script": "true"},
		}
		h.expect("POST", "/api/servers", sp, 202)
		h.waitState(s.uuid, "offline", 60*time.Second)
		h.expect("POST", "/api/servers/"+s.uuid+"/power", map[string]string{"action": "start"}, 202)
		h.waitState(s.uuid, "online", 60*time.Second)
		return s
	}
	a, b, px := mk("server-a"), mk("server-b"), mk("proxy")

	exec := func(ctr string, cmd ...string) string {
		t.Helper()
		ex, err := cli.ContainerExecCreate(ctx, ctr, container.ExecOptions{Cmd: cmd, AttachStdout: true, AttachStderr: true})
		if err != nil {
			t.Fatal(err)
		}
		att, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
		if err != nil {
			t.Fatal(err)
		}
		_ = att.Conn.SetReadDeadline(time.Now().Add(20 * time.Second))
		out, _ := io.ReadAll(att.Reader)
		att.Close()
		return string(out)
	}
	// nc met timeout; de servers antwoorden met hun woord.
	reach := func(from, host string, port int) string {
		t.Helper()
		return exec(server.ContainerName(from), "sh", "-c", fmt.Sprintf("nc -w 3 %s %d </dev/null 2>&1", host, port))
	}
	ipOn := func(netName, ctr string) string {
		t.Helper()
		ni, err := cli.NetworkInspect(ctx, netName, network.InspectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range ni.Containers {
			if c.Name == ctr {
				ip, _, _ := strings.Cut(c.IPv4Address, "/")
				return ip
			}
		}
		t.Fatalf("%s niet op %s", ctr, netName)
		return ""
	}

	// Elke server op zijn eigen netwerk, met een subnet uit de testpool, alleen hijzelf erop.
	for _, s := range []srv{a, b, px} {
		ci, err := cli.ContainerInspect(ctx, server.ContainerName(s.uuid))
		if err != nil {
			t.Fatal(err)
		}
		if len(ci.NetworkSettings.Networks) != 1 || ci.NetworkSettings.Networks[server.SiteNetwork(s.uuid)] == nil {
			t.Fatalf("netwerken van %s: %v", s.uuid, ci.NetworkSettings.Networks)
		}
		ni, _ := cli.NetworkInspect(ctx, server.SiteNetwork(s.uuid), network.InspectOptions{})
		if len(ni.IPAM.Config) != 1 || !strings.HasPrefix(ni.IPAM.Config[0].Subnet, "10.252.") || !strings.HasSuffix(ni.IPAM.Config[0].Subnet, "/28") || len(ni.Containers) != 1 {
			t.Fatalf("netwerk %s: %+v, %d containers", ni.Name, ni.IPAM.Config, len(ni.Containers))
		}
	}
	bIP := ipOn(server.SiteNetwork(b.uuid), server.ContainerName(b.uuid))
	infraIP := ipOn(infraNet, infraCtr)

	// Gepubliceerde poort vanaf de host.
	if got := dialRead(t, fmt.Sprintf("127.0.0.1:%d", b.port)); !strings.Contains(got, "server-b") {
		t.Fatalf("gepubliceerde poort: %q", got)
	}
	// A bereikt B niet (IP en naam) en de infra niet.
	if out := reach(a.uuid, bIP, b.port); strings.Contains(out, "server-b") {
		t.Fatalf("A bereikt B op IP: %q", out)
	}
	if out := reach(a.uuid, server.ContainerName(b.uuid), b.port); strings.Contains(out, "server-b") {
		t.Fatalf("A bereikt B op naam: %q", out)
	}
	if out := reach(a.uuid, infraIP, 7000); strings.Contains(out, "infra") {
		t.Fatalf("A bereikt infra: %q", out)
	}
	// Uitgaand internet (alleen als de host het zelf heeft).
	if c, err := net.DialTimeout("tcp", "example.com:80", 3*time.Second); err == nil {
		c.Close()
		if out := exec(server.ContainerName(a.uuid), "sh", "-c", "wget -T 8 -qO- http://example.com/ 2>&1 | head -c 200"); !strings.Contains(strings.ToLower(out), "<html") && !strings.Contains(strings.ToLower(out), "<!doctype") {
			t.Fatalf("geen uitgaand internet: %q", out)
		}
	} else {
		t.Log("host heeft geen internet; uitgaand verkeer niet getest")
	}

	// Velocity-netwerk: proxy + B.
	if out := reach(px.uuid, server.ContainerName(b.uuid), b.port); strings.Contains(out, "server-b") {
		t.Fatalf("proxy bereikt B al vóór het netwerk: %q", out)
	}
	h.expect("PUT", "/api/servers/"+px.uuid+"/network", map[string]any{"members": []string{b.uuid}}, 200)
	if out := reach(px.uuid, server.ContainerName(b.uuid), b.port); !strings.Contains(out, "server-b") {
		t.Fatalf("proxy bereikt backend niet: %q", out)
	}
	if out := reach(px.uuid, server.ContainerName(a.uuid), a.port); strings.Contains(out, "server-a") {
		t.Fatalf("proxy bereikt een server buiten zijn netwerk: %q", out)
	}
	bProxyIP := ipOn(server.ProxyNetwork(px.uuid), server.ContainerName(b.uuid))
	if out := reach(a.uuid, bProxyIP, b.port); strings.Contains(out, "server-b") {
		t.Fatalf("A bereikt B via het proxy-netwerk: %q", out)
	}
	// Na een herstart van de backend: weer bereikbaar (nieuwe container, opnieuw gekoppeld vóór de start).
	h.expect("POST", "/api/servers/"+b.uuid+"/power", map[string]string{"action": "restart"}, 202)
	time.Sleep(500 * time.Millisecond)
	h.waitState(b.uuid, "online", 60*time.Second)
	if out := reach(px.uuid, server.ContainerName(b.uuid), b.port); !strings.Contains(out, "server-b") {
		t.Fatalf("proxy bereikt backend niet na herstart: %q", out)
	}
	if got := dialRead(t, fmt.Sprintf("127.0.0.1:%d", b.port)); !strings.Contains(got, "server-b") {
		t.Fatalf("gepubliceerde poort na herstart: %q", got)
	}

	// Opruimen: proxy weg → zijn netwerk weg; backend weg → zijn eigen netwerk weg.
	for _, s := range []srv{px, b} {
		h.expect("DELETE", "/api/servers/"+s.uuid, nil, 204)
	}
	for _, n := range []string{server.ProxyNetwork(px.uuid), server.SiteNetwork(px.uuid), server.SiteNetwork(b.uuid)} {
		if _, err := cli.NetworkInspect(ctx, n, network.InspectOptions{}); err == nil {
			t.Fatalf("netwerk %s niet opgeruimd", n)
		}
	}
	if _, err := cli.ContainerInspect(ctx, infraCtr); err != nil {
		t.Fatal("infra-container aangeraakt")
	}
}

// dialRead verbindt met addr en leest wat de server stuurt (een paar pogingen: de nc-lus
// heeft even nodig tussen verbindingen).
func dialRead(t *testing.T, addr string) string {
	t.Helper()
	var last string
	for i := 0; i < 20; i++ {
		c, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err == nil {
			_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
			b, _ := io.ReadAll(c)
			c.Close()
			if last = string(b); last != "" {
				return last
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return last
}
