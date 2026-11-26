package daemon

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
	"panel/daemon/internal/testpanel"
	"panel/daemon/proxy"
)

const u1 = "0b7c2d1e-1111-4222-8333-444455556666"

func TestAuthAndSystem(t *testing.T) {
	h := newHarness(t, engine.NewFake(), nil, nil, "", nil, "")
	for _, tok := range []string{"", "fout"} {
		if r := h.doTok("GET", "/api/system", nil, tok); r.Code != 401 || !strings.Contains(string(r.Body), `"error":"unauthorized"`) {
			t.Fatalf("token %q: %d %s", tok, r.Code, r.Body)
		}
	}
	var si map[string]any
	h.expect("GET", "/api/system", nil, 200).json(t, &si)
	for _, k := range []string{"version", "disk_quota_mode", "cpu_count", "memory_total_bytes", "memory_used_bytes", "disk_total_bytes", "disk_free_bytes", "docker_version", "server_count"} {
		if _, ok := si[k]; !ok {
			t.Errorf("system mist %s", k)
		}
	}
	if si["disk_quota_mode"] != "soft" || si["docker_version"] != "fake-1.0" {
		t.Fatal(si)
	}
	h.expect("GET", "/api/onbekend", nil, 404)
	h.expect("GET", "/api/servers/"+u1, nil, 404)
	h.expect("GET", "/api/servers/"+u1+"/files/list?path=/", nil, 501)
	h.expect("POST", "/api/servers/"+u1+"/backups", map[string]any{}, 501)
	if r := h.doTok("GET", "/api/servers/"+u1+"/files/list?path=/", nil, ""); r.Code != 401 {
		t.Fatal("files zonder token", r.Code)
	}
	// unix-socket bestaat met 0660
	fi, err := os.Stat(h.cfg.DaemonSocket)
	if err != nil || fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o660 {
		t.Fatal("socket", err, fi.Mode())
	}
	// Hello naar het panel
	waitFor(t, "hello", 2*time.Second, func() bool { return len(h.panel.Calls("/api/remote/node/hello")) == 1 })
}

func TestStaleSocketRemoved(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "daemon.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ln.SetUnlinkOnClose(false)
	ln.Close() // oud socketbestand blijft liggen, zoals na een harde kill
	h := newHarness(t, engine.NewFake(), nil, nil, dir, nil, "")
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	h.stop()
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Fatal("socket niet opgeruimd bij stop")
	}
}

func TestServerLifecycle(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, "")
	sp := testSpec(u1)
	var v server.View
	h.expect("POST", "/api/servers", sp, 202).json(t, &v)
	if v.UUID != u1 || v.State != "installing" {
		t.Fatalf("%+v", v)
	}
	v = h.waitState(u1, "offline", 5*time.Second)
	if v.InstalledAt == nil || v.StartedAt != nil {
		t.Fatalf("%+v", v)
	}
	waitFor(t, "install-melding", 2*time.Second, func() bool {
		c := h.panel.Calls("/api/remote/servers/" + u1 + "/install")
		return len(c) == 1 && c[0].Body["successful"] == true
	})
	if eng.Container(server.ContainerName(u1)+"-install") != nil {
		t.Fatal("install-container niet opgeruimd")
	}
	// idempotent
	h.expect("POST", "/api/servers", sp, 202)
	sp2 := testSpec(u1)
	sp2["image"] = "ander"
	h.expect("POST", "/api/servers", sp2, 409)
	bad := testSpec(u1)
	bad["uuid"] = "x"
	h.expect("POST", "/api/servers", bad, 400)
	var list []server.View
	h.expect("GET", "/api/servers", nil, 200).json(t, &list)
	if len(list) != 1 {
		t.Fatal(list)
	}

	h.expect("POST", "/api/servers/"+u1+"/commands", map[string]any{"commands": []string{"x"}}, 409)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "dans"}, 400)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	v = h.waitState(u1, "online", 5*time.Second)
	if v.StartedAt == nil {
		t.Fatal("started_at")
	}
	c := eng.Container(server.ContainerName(u1))
	cfg := c.Config
	if cfg.User != "1000:1000" || !cfg.ReadOnlyRootfs || !slices.Equal(cfg.CapDrop, []string{"ALL"}) || !slices.Contains(cfg.SecurityOpt, "no-new-privileges") ||
		cfg.Resources.PidsLimit != 512 || cfg.Resources.Memory != 512<<20 || cfg.Resources.MemorySwap != 512<<20 || cfg.Resources.NanoCPUs != 1e9 ||
		cfg.Tmpfs["/tmp"] == "" || cfg.WorkingDir != "/home/container" || !cfg.OpenStdin {
		t.Fatalf("containerconfig: %+v", cfg)
	}
	if cfg.Labels["panel.managed"] != "true" || cfg.Labels["panel.instance"] != "unit" || cfg.Labels["panel.server_uuid"] != u1 || cfg.Labels["panel.role"] != "server" || cfg.Labels["panel.test"] != "true" {
		t.Fatal(cfg.Labels)
	}
	if cfg.Cmd[0] != "run --mem 512" || !slices.Contains(cfg.Env, "FOO=bar") || !slices.Contains(cfg.Env, "SERVER_PORT=25565") || !slices.Contains(cfg.Env, "TZ=Europe/Amsterdam") {
		t.Fatal(cfg.Cmd, cfg.Env)
	}
	if len(cfg.Ports) != 2 || cfg.Ports[0].HostIP != "127.0.0.1" || cfg.Ports[0].HostPort != 25565 {
		t.Fatal(cfg.Ports)
	}
	props, _ := os.ReadFile(filepath.Join(h.cfg.DataDir, "volumes", u1, "server.properties"))
	if string(props) != "foo=bar\nserver-port=25565\n" {
		t.Fatalf("properties: %q", props)
	}

	h.expect("POST", "/api/servers/"+u1+"/commands", map[string]any{"commands": []string{"say hallo"}}, 204)
	waitFor(t, "hallo in logs", 2*time.Second, func() bool {
		var l struct{ Lines []string }
		h.expect("GET", "/api/servers/"+u1+"/logs?lines=500", nil, 200).json(t, &l)
		return slices.Contains(l.Lines, "[Server] hallo")
	})
	var l struct{ Lines []string }
	h.expect("GET", "/api/servers/"+u1+"/logs?lines=1", nil, 200).json(t, &l)
	if len(l.Lines) != 1 {
		t.Fatal(l)
	}
	h.expect("GET", "/api/servers/"+u1+"/logs?lines=501", nil, 400)
	waitFor(t, "stats", 2*time.Second, func() bool {
		var st server.Stats
		h.expect("GET", "/api/servers/"+u1+"/stats", nil, 200).json(t, &st)
		return st.MemoryBytes > 0 && st.MemoryLimitBytes == 512<<20 && st.DiskLimitBytes == 1024<<20 && st.UptimeMs >= 0
	})
	waitFor(t, "disk_bytes", 2*time.Second, func() bool { return h.state(u1).DiskBytes > 0 })

	// PUT: limieten direct via docker update
	sp3 := testSpec(u1)
	sp3["limits"] = map[string]any{"cpu_pct": 200, "memory_mb": 1024, "swap_mb": -1, "disk_mb": 0}
	h.expect("PUT", "/api/servers/"+u1, sp3, 200)
	if u := c.Updates(); len(u) != 1 || u[0].Memory != 1024<<20 || u[0].MemorySwap != -1 || u[0].NanoCPUs != 2e9 {
		t.Fatal(u)
	}
	sp4 := testSpec("0b7c2d1e-1111-4222-8333-000000000000")
	h.expect("PUT", "/api/servers/"+u1, sp4, 400)

	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "restart"}, 202)
	waitFor(t, "nieuwe container", 5*time.Second, func() bool {
		nc := eng.Container(server.ContainerName(u1))
		return nc != nil && nc != c && h.state(u1).State == "online"
	})
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 5*time.Second)

	sts := h.panel.Statuses(u1)
	for _, want := range []string{"installing", "offline", "starting", "online", "stopping"} {
		if !slices.Contains(sts, want) {
			t.Errorf("status %s niet gemeld: %v", want, sts)
		}
	}

	h.expect("DELETE", "/api/servers/"+u1, nil, 204)
	h.expect("GET", "/api/servers/"+u1, nil, 404)
	if eng.Container(server.ContainerName(u1)) != nil {
		t.Fatal("container niet verwijderd")
	}
	if _, err := os.Stat(filepath.Join(h.cfg.DataDir, "volumes", u1)); !os.IsNotExist(err) {
		t.Fatal("data niet verwijderd")
	}
	h.expect("DELETE", "/api/servers/"+u1, nil, 404)
}

func TestInstallFailureAndBusy(t *testing.T) {
	eng := engine.NewFake()
	release := make(chan struct{})
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Println("bezig")
			<-release
			c.Println("kapot")
			c.Exit(3)
			return
		}
		engine.DefaultBehavior(c)
	}
	h := newHarness(t, eng, nil, nil, "", nil, "")
	h.expect("POST", "/api/servers", testSpec(u1), 202)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 409)
	h.expect("POST", "/api/servers/"+u1+"/install", nil, 409)

	ws := h.ws(u1, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read"}})})
	ws.next("install-backlog", 2*time.Second, lineMatch("install_output", "bezig"))
	close(release)
	ws.next("install-regel", 2*time.Second, lineMatch("install_output", "kapot"))
	ws.next("status install_failed", 2*time.Second, func(m map[string]any) bool { return m["state"] == "install_failed" })

	h.waitState(u1, "install_failed", 2*time.Second)
	waitFor(t, "install-melding", 2*time.Second, func() bool {
		c := h.panel.Calls("/api/remote/servers/" + u1 + "/install")
		return len(c) == 1 && c[0].Body["successful"] == false && strings.Contains(c[0].Body["error"].(string), "exitcode 3")
	})
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 409)

	// herinstallatie die lukt, start niet vanzelf
	eng.Behavior = nil
	h.expect("POST", "/api/servers/"+u1+"/install", nil, 202)
	h.waitState(u1, "offline", 3*time.Second)
}

func TestStartOnInstallAndSkipInstall(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", nil, "")
	sp := testSpec(u1)
	sp["start_on_install"] = true
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)

	u2 := "0b7c2d1e-1111-4222-8333-000000000002"
	sp2 := testSpec(u2)
	sp2["skip_install"] = true
	var v server.View
	h.expect("POST", "/api/servers", sp2, 202).json(t, &v)
	if v.State != "offline" || v.InstalledAt == nil {
		t.Fatalf("%+v", v)
	}
	if eng.Container(server.ContainerName(u2)+"-install") != nil {
		t.Fatal("skip_install maakte toch een install-container")
	}
}

func TestStopTimeoutKills(t *testing.T) {
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
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	start := time.Now()
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "stopping", time.Second)
	h.waitState(u1, "offline", 6*time.Second)
	if d := time.Since(start); d < 2500*time.Millisecond {
		t.Fatalf("te vroeg gekilld: %v", d)
	}
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "kill"}, 202)
	h.waitState(u1, "offline", 2*time.Second)
}

func TestRecoveryAfterRestart(t *testing.T) {
	eng := engine.NewFake()
	dir := t.TempDir()
	h := newHarness(t, eng, nil, nil, dir, nil, "")
	sp := testSpec(u1)
	sp["start_on_install"] = true
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	c := eng.Container(server.ContainerName(u1))
	h.expect("POST", "/api/servers/"+u1+"/commands", map[string]any{"commands": []string{"say voor"}}, 204)

	// Ook een container van een ander instance en een infra-container: niet aanraken.
	foreign, _ := eng.Create(context.Background(), engine.ContainerConfig{Name: "vreemd", Labels: map[string]string{"panel.managed": "true", "panel.instance": "unit", "panel.role": "infra"}})
	_ = eng.Start(context.Background(), foreign)

	h.stop()
	if !c.Running() {
		t.Fatal("daemon-stop stopte de container")
	}
	h.start()
	v := h.waitState(u1, "online", 3*time.Second)
	if v.StartedAt == nil {
		t.Fatal("started_at na herstel")
	}
	if eng.Container(server.ContainerName(u1)) != c {
		t.Fatal("container vervangen bij herstel")
	}
	if fc := eng.Container("vreemd"); fc == nil || !fc.Running() {
		t.Fatal("infra-container aangeraakt")
	}
	ws := h.ws(u1, nil)
	ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read", "console.write"}})})
	ws.next("auth_success", 2*time.Second, ev("auth_success"))
	ws.next("backlog met Done", 2*time.Second, lineMatch("console_output", "Done ("))
	ws.next("backlog met voor", 2*time.Second, lineMatch("console_output", "[Server] voor"))
	ws.next("status online", 2*time.Second, func(m map[string]any) bool { return m["event"] == "status" && m["state"] == "online" })
	ws.send(map[string]any{"event": "send_command", "command": "say terug"})
	ws.next("terug", 2*time.Second, lineMatch("console_output", "[Server] terug"))

	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 5*time.Second)
	// herstel van een gestopte server: offline, zonder container te starten
	h.restart()
	if st := h.state(u1).State; st != "offline" {
		t.Fatal(st)
	}
}

func TestRecoveryInterruptedInstall(t *testing.T) {
	eng := engine.NewFake()
	block := make(chan struct{})
	defer close(block)
	eng.Behavior = func(c *engine.FakeContainer) { <-block }
	dir := t.TempDir()
	h := newHarness(t, eng, nil, nil, dir, nil, "")
	h.expect("POST", "/api/servers", testSpec(u1), 202)
	waitFor(t, "install-container", 2*time.Second, func() bool { return eng.Container(server.ContainerName(u1)+"-install") != nil })
	h.restart()
	if st := h.state(u1).State; st != "install_failed" {
		t.Fatal(st)
	}
	if eng.Container(server.ContainerName(u1)+"-install") != nil {
		t.Fatal("achtergebleven install-container niet opgeruimd")
	}
	waitFor(t, "install-melding", 2*time.Second, func() bool {
		c := h.panel.Calls("/api/remote/servers/" + u1 + "/install")
		return len(c) == 1 && c[0].Body["successful"] == false
	})
}

func TestWebsocket(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", nil, "")
	sp := testSpec(u1)
	sp["start_on_install"] = true
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	tok := func(ttl time.Duration, perms ...string) string {
		return h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: perms, TTL: ttl})
	}

	t.Run("volledige sessie", func(t *testing.T) {
		ws := h.ws(u1, http.Header{"Origin": {"https://panel.test"}})
		ws.send(map[string]any{"event": "auth", "token": tok(0, "console.read")})
		m := ws.next("auth_success", 2*time.Second, ev("auth_success"))
		if p, _ := m["permissions"].([]any); len(p) != 1 || p[0] != "console.read" {
			t.Fatal(m)
		}
		if len(ws.seen) != 1 {
			t.Fatal("auth_success moet het eerste bericht zijn")
		}
		ws.next("backlog", 2*time.Second, lineMatch("console_output", "Done ("))
		ws.next("status", 2*time.Second, func(m map[string]any) bool { return m["event"] == "status" && m["state"] == "online" })
		ws.send(map[string]any{"event": "send_command", "command": "say x"})
		ws.next("geen console.write", 2*time.Second, func(m map[string]any) bool {
			return m["event"] == "error" && strings.Contains(m["message"].(string), "console.write")
		})
		ws.send(map[string]any{"event": "set_state", "state": "stop"})
		ws.next("geen power", 2*time.Second, func(m map[string]any) bool {
			return m["event"] == "error" && strings.Contains(m["message"].(string), "power")
		})
		ws.send(map[string]any{"event": "request_stats"})
		st := ws.next("stats", 2*time.Second, ev("stats"))
		if st["memory_limit_bytes"].(float64) != 512<<20 {
			t.Fatal(st)
		}
		// refresh met meer rechten
		ws.send(map[string]any{"event": "auth", "token": tok(0, "console.read", "console.write")})
		ws.next("auth_success 2", 2*time.Second, ev("auth_success"))
		ws.send(map[string]any{"event": "send_command", "command": "say hallo"})
		ws.next("hallo", 2*time.Second, lineMatch("console_output", "[Server] hallo"))
		ws.next("periodieke stats", 2*time.Second, ev("stats"))
		ws.send(map[string]any{"event": "dans"})
		ws.next("onbekend event", 2*time.Second, ev("error"))
		// token van een andere gebruiker bij refresh: sluiten
		ws.send(map[string]any{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Subject: "99", Permissions: []string{"console.read"}})})
		if code := ws.waitClosed(3 * time.Second); code != 4001 {
			t.Fatal(code)
		}
	})

	t.Run("token verloopt", func(t *testing.T) {
		ws := h.ws(u1, nil)
		ws.send(map[string]any{"event": "auth", "token": tok(2*time.Second, "console.read")})
		m := ws.next("token_expiring", 2*time.Second, ev("token_expiring"))
		if _, err := time.Parse(time.RFC3339, m["expires_at"].(string)); err != nil {
			t.Fatal(m)
		}
		ws.next("token_expired", 4*time.Second, ev("token_expired"))
		if code := ws.waitClosed(3 * time.Second); code != 4001 {
			t.Fatal(code)
		}
	})

	t.Run("refresh houdt verbinding open", func(t *testing.T) {
		ws := h.ws(u1, nil)
		ws.send(map[string]any{"event": "auth", "token": tok(2*time.Second, "console.read")})
		ws.next("token_expiring", 2*time.Second, ev("token_expiring"))
		ws.send(map[string]any{"event": "auth", "token": tok(0, "console.read")})
		ws.next("auth_success", 2*time.Second, ev("auth_success"))
		time.Sleep(2500 * time.Millisecond)
		for _, m := range ws.seen {
			if m["event"] == "token_expired" {
				t.Fatal("verlopen na refresh")
			}
		}
		ws.send(map[string]any{"event": "request_stats"})
		ws.next("nog open", 2*time.Second, ev("stats"))
	})

	cases := []struct {
		name  string
		uuid  string
		token string
		code  int
	}{
		{"andere server", u1, h.panel.Sign(testpanel.TokenOpts{Server: "0b7c2d1e-1111-4222-8333-000000000009", Permissions: []string{"console.read"}}), 4001},
		{"onbekende server", "00000000-0000-4000-8000-000000000000", tok(0, "console.read"), 4004},
		{"geen console.read", u1, tok(0, "power"), 4003},
		{"ongeldig token", u1, "x.y.z", 4001},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ws := h.ws(c.uuid, nil)
			ws.send(map[string]any{"event": "auth", "token": c.token})
			if code := ws.waitClosed(3 * time.Second); code != c.code {
				t.Fatalf("code %d, verwacht %d", code, c.code)
			}
		})
	}
	t.Run("geen auth", func(t *testing.T) {
		ws := h.ws(u1, nil)
		if code := ws.waitClosed(3 * time.Second); code != 4008 {
			t.Fatal(code)
		}
	})
	t.Run("eerst iets anders dan auth", func(t *testing.T) {
		ws := h.ws(u1, nil)
		ws.send(map[string]any{"event": "request_stats"})
		if code := ws.waitClosed(3 * time.Second); code != 4001 {
			t.Fatal(code)
		}
	})
	t.Run("verkeerde origin", func(t *testing.T) {
		url := "ws://" + h.d.TCPAddr() + "/api/servers/" + u1 + "/ws"
		_, res, err := websocketDial(url, http.Header{"Origin": {"https://evil.test"}})
		if err == nil || res == nil || res.StatusCode != 403 {
			t.Fatal(err, res)
		}
	})
	t.Run("power via websocket en verwijderen sluit met 4004", func(t *testing.T) {
		ws := h.ws(u1, nil)
		ws.send(map[string]any{"event": "auth", "token": tok(0, "console.read", "power")})
		ws.next("auth_success", 2*time.Second, ev("auth_success"))
		ws.send(map[string]any{"event": "set_state", "state": "restart"})
		ws.next("stopping", 3*time.Second, func(m map[string]any) bool { return m["state"] == "stopping" })
		ws.next("starting", 3*time.Second, func(m map[string]any) bool { return m["state"] == "starting" })
		ws.next("online", 3*time.Second, func(m map[string]any) bool { return m["state"] == "online" })
		h.expect("DELETE", "/api/servers/"+u1, nil, 204)
		if code := ws.waitClosed(3 * time.Second); code != 4004 {
			t.Fatal(code)
		}
	})
}

func TestRoutes(t *testing.T) {
	eng := engine.NewFake()
	router := proxy.NewFake()
	dir := t.TempDir()
	h := newHarness(t, eng, router, nil, dir, nil, "")
	web := testSpec(u1)
	web["type"] = "web"
	web["allocations"] = []any{}
	web["http_port"] = 8080
	h.expect("POST", "/api/servers", web, 202)
	u2 := "0b7c2d1e-1111-4222-8333-000000000002"
	game := testSpec(u2)
	h.expect("POST", "/api/servers", game, 202)

	h.expect("PUT", "/api/routes/site.test", map[string]any{"host": "site.test", "server_uuid": "0b7c2d1e-1111-4222-8333-00000000dead"}, 404)
	h.expect("PUT", "/api/routes/site.test", map[string]any{"host": "ander.test", "server_uuid": u1}, 400)
	h.expect("PUT", "/api/routes/kapot_host", map[string]any{"server_uuid": u1}, 400)
	h.expect("PUT", "/api/routes/game.test", map[string]any{"server_uuid": u2}, 400) // geen port, geen http_port
	var rs map[string]any
	h.expect("PUT", "/api/routes/Site.Test", map[string]any{"host": "site.test", "server_uuid": u1}, 200).json(t, &rs)
	if rs["ssl_status"] != "active" || rs["host"] != "site.test" {
		t.Fatal(rs)
	}
	h.expect("PUT", "/api/routes/www.site.test", map[string]any{"server_uuid": u1, "redirect_to": "site.test"}, 200)
	h.expect("PUT", "/api/routes/%2A.site.test", map[string]any{"server_uuid": u1, "port": 9000}, 200).json(t, &rs)
	if rs["wildcard"] != true {
		t.Fatal(rs)
	}
	routes := router.Routes()
	if len(routes) != 3 || routes[1].Host != "site.test" || routes[1].Upstream.Container != "panel-"+u1 || routes[1].Upstream.Port != 8080 ||
		routes[0].Host != "*.site.test" || routes[0].Upstream.Port != 9000 || routes[2].RedirectTo != "site.test" {
		t.Fatalf("%+v", routes)
	}
	var list []map[string]any
	h.expect("GET", "/api/routes", nil, 200).json(t, &list)
	if len(list) != 3 {
		t.Fatal(list)
	}
	router.Statuses["site.test"] = proxy.SSLDNSWrong
	h.expect("GET", "/api/routes/site.test", nil, 200).json(t, &rs)
	if rs["ssl_status"] != "dns_wrong" {
		t.Fatal(rs)
	}
	h.expect("GET", "/api/routes/nope.test", nil, 404)

	// herstart: Sync met de opgeslagen routes (ook als Caddy ze kwijt is)
	_ = router.Sync(context.Background(), nil)
	h.restart()
	if len(router.Routes()) != 3 {
		t.Fatal("geen Sync bij de start", router.Routes())
	}
	h.expect("DELETE", "/api/routes/www.site.test", nil, 204)
	h.expect("DELETE", "/api/routes/www.site.test", nil, 404)
	h.expect("DELETE", "/api/servers/"+u1, nil, 204)
	if len(router.Routes()) != 0 {
		t.Fatal("routes van verwijderde server", router.Routes())
	}
	h.expect("GET", "/api/routes", nil, 200).json(t, &list)
	if len(list) != 0 {
		t.Fatal(list)
	}
}

func websocketDial(url string, h http.Header) (*websocket.Conn, *http.Response, error) {
	return websocket.DefaultDialer.Dial(url, h)
}
