package daemon

import (
	"encoding/json"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/server"
	"panel/daemon/internal/testpanel"
)

// termClient is een webterminal-client: tekstframes zijn JSON, binaire frames uitvoer.
type termClient struct {
	t      *testing.T
	conn   *websocket.Conn
	mu     sync.Mutex
	out    strings.Builder
	events []map[string]any
	closed chan int
}

func (h *harness) term(uuid string) *termClient {
	h.t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+h.d.TCPAddr()+"/api/servers/"+uuid+"/terminal", nil)
	if err != nil {
		h.t.Fatal(err)
	}
	c := &termClient{t: h.t, conn: conn, closed: make(chan int, 1)}
	go func() {
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				code := -1
				if ce, ok := err.(*websocket.CloseError); ok {
					code = ce.Code
				}
				c.closed <- code
				return
			}
			c.mu.Lock()
			if mt == websocket.BinaryMessage {
				c.out.Write(data)
			} else {
				var m map[string]any
				_ = json.Unmarshal(data, &m)
				c.events = append(c.events, m)
			}
			c.mu.Unlock()
		}
	}()
	h.t.Cleanup(func() { conn.Close() })
	return c
}

func (c *termClient) json(v any) {
	c.t.Helper()
	if err := c.conn.WriteJSON(v); err != nil {
		c.t.Fatal(err)
	}
}

func (c *termClient) input(s string) {
	c.t.Helper()
	if err := c.conn.WriteMessage(websocket.BinaryMessage, []byte(s)); err != nil {
		c.t.Fatal(err)
	}
}

func (c *termClient) waitOut(sub string, timeout time.Duration) {
	c.t.Helper()
	waitFor(c.t, "uitvoer "+sub, timeout, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return strings.Contains(c.out.String(), sub)
	})
}

func (c *termClient) waitEvent(name string, timeout time.Duration) map[string]any {
	c.t.Helper()
	var got map[string]any
	waitFor(c.t, "event "+name, timeout, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, e := range c.events {
			if e["event"] == name {
				got = e
				return true
			}
		}
		return false
	})
	return got
}

func (c *termClient) waitClosed(timeout time.Duration) int {
	c.t.Helper()
	select {
	case code := <-c.closed:
		return code
	case <-time.After(timeout):
		c.t.Fatal("terminal niet gesloten")
		return 0
	}
}

func shellContainers(eng *engine.Fake, uuid string) []*engine.FakeContainer {
	var out []*engine.FakeContainer
	for _, c := range eng.All() {
		if c.Config.Labels["panel.role"] == server.RoleShell && c.Config.Labels["panel.server_uuid"] == uuid {
			out = append(out, c)
		}
	}
	return out
}

func newTermHarness(t *testing.T) (*harness, *engine.Fake) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, "")
	sp := testSpec(u1)
	sp["skip_install"] = true
	h.expect("POST", "/api/servers", sp, 202)
	return h, eng
}

func (h *harness) termToken(uuid string) string {
	return h.panel.Sign(testpanel.TokenOpts{Server: uuid, Permissions: []string{"terminal"}, Purpose: "terminal"})
}

func TestTerminalSession(t *testing.T) {
	h, eng := newTermHarness(t)
	c := h.term(u1)
	tok := h.termToken(u1)
	c.json(map[string]any{"event": "auth", "token": tok, "cols": 120, "rows": 40})
	c.waitEvent("auth_success", 5*time.Second)
	c.waitOut("$ ", 5*time.Second)

	// container: eigen rol, server-labels, zonder privileges, alleen de serverdata, op het site-netwerk
	list := shellContainers(eng, u1)
	if len(list) != 1 {
		t.Fatalf("%d shell-containers", len(list))
	}
	sc := list[0]
	cfg := sc.Config
	if !strings.HasPrefix(cfg.Name, "panel-"+u1+"-shell-") || cfg.Labels["panel.managed"] != "true" || cfg.Labels["panel.instance"] != "unit" || cfg.Labels["panel.test"] != "true" {
		t.Fatalf("naam/labels: %s %v", cfg.Name, cfg.Labels)
	}
	if !cfg.Tty || !cfg.OpenStdin || cfg.User != "1000:1000" || !cfg.ReadOnlyRootfs || !slices.Equal(cfg.CapDrop, []string{"ALL"}) || !slices.Contains(cfg.SecurityOpt, "no-new-privileges") {
		t.Fatalf("beveiliging: %+v", cfg)
	}
	if cfg.NetworkMode != server.SiteNetwork(u1) || len(cfg.Mounts) != 1 || cfg.Mounts[0].Target != "/home/container" || !strings.HasSuffix(cfg.Mounts[0].Source, "/volumes/"+u1) {
		t.Fatalf("netwerk/mounts: %s %+v", cfg.NetworkMode, cfg.Mounts)
	}
	if cfg.Image != "fake/server:1" || cfg.Resources.Memory != 512*1024*1024 || cfg.Resources.PidsLimit > 256 {
		t.Fatalf("image/limieten: %s %+v", cfg.Image, cfg.Resources)
	}
	if !slices.Contains(cfg.Env, "FOO=bar") || !slices.Contains(cfg.Env, "TERM=xterm-256color") {
		t.Fatalf("env: %v", cfg.Env)
	}
	if rows, cols, ok := eng.TTYSize(sc.ID); !ok || rows != 40 || cols != 120 {
		t.Fatalf("grootte: %d×%d %v", cols, rows, ok)
	}

	c.input("echo hallo\r")
	c.waitOut("out:echo hallo", 5*time.Second)
	c.json(map[string]any{"event": "resize", "cols": 9999, "rows": 10})
	waitFor(t, "resize", 2*time.Second, func() bool { r, cl, _ := eng.TTYSize(sc.ID); return r == 10 && cl == 500 })

	// refresh met een nieuw token; hetzelfde token opnieuw is geweigerd (eenmalig)
	c.json(map[string]any{"event": "auth", "token": h.termToken(u1)})
	waitFor(t, "tweede auth_success", 5*time.Second, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		n := 0
		for _, e := range c.events {
			if e["event"] == "auth_success" {
				n++
			}
		}
		return n == 2
	})
	c2 := h.term(u1)
	c2.json(map[string]any{"event": "auth", "token": tok})
	if code := c2.waitClosed(5 * time.Second); code != 4001 {
		t.Fatalf("hergebruikt token: %d", code)
	}

	// exit → terminal_exit, sluiten met 1000, container weg
	c.input("exit\r")
	e := c.waitEvent("terminal_exit", 5*time.Second)
	if e["code"] != float64(0) {
		t.Fatalf("%v", e)
	}
	if code := c.waitClosed(5 * time.Second); code != websocket.CloseNormalClosure {
		t.Fatalf("sluitcode %d", code)
	}
	waitFor(t, "shell opgeruimd", 5*time.Second, func() bool { return len(shellContainers(eng, u1)) == 0 && h.d.Manager().Shells(u1) == 0 })
}

func TestTerminalRefusals(t *testing.T) {
	h, eng := newTermHarness(t)
	try := func(tok string, uuid string) int {
		c := h.term(uuid)
		c.json(map[string]any{"event": "auth", "token": tok})
		return c.waitClosed(5 * time.Second)
	}
	// console-token (zonder purpose) geldt hier niet, ook niet met recht terminal
	if code := try(h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read", "terminal"}}), u1); code != 4003 {
		t.Fatalf("console-token: %d", code)
	}
	if code := try(h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"files.write"}, Purpose: "terminal"}), u1); code != 4003 {
		t.Fatalf("zonder recht: %d", code)
	}
	if code := try(h.termToken("0b7c2d1e-1111-4222-8333-00000000ffff"), u1); code != 4001 {
		t.Fatalf("andere server: %d", code)
	}
	if code := try(h.termToken("0b7c2d1e-1111-4222-8333-00000000ffff"), "0b7c2d1e-1111-4222-8333-00000000ffff"); code != 4004 {
		t.Fatalf("onbekende server: %d", code)
	}
	if code := try("kapot", u1); code != 4001 {
		t.Fatalf("ongeldig: %d", code)
	}
	// geen auth binnen de timeout
	c := h.term(u1)
	if code := c.waitClosed(5 * time.Second); code != 4008 {
		t.Fatalf("auth-timeout: %d", code)
	}
	if n := len(shellContainers(eng, u1)); n != 0 {
		t.Fatalf("%d shells na weigeringen", n)
	}

	// maximaal 3 per server
	var open []*termClient
	for i := 0; i < 3; i++ {
		c := h.term(u1)
		c.json(map[string]any{"event": "auth", "token": h.termToken(u1)})
		c.waitEvent("auth_success", 5*time.Second)
		open = append(open, c)
	}
	if code := try(h.termToken(u1), u1); code != 4029 {
		t.Fatalf("vierde shell: %d", code)
	}
	// verbinding verbreken (zonder exit) ruimt de container op
	for _, c := range open {
		c.conn.Close()
	}
	waitFor(t, "shells opgeruimd", 5*time.Second, func() bool { return len(shellContainers(eng, u1)) == 0 })
}

func TestTerminalOrphansAndDelete(t *testing.T) {
	h, eng := newTermHarness(t)
	c := h.term(u1)
	c.json(map[string]any{"event": "auth", "token": h.termToken(u1)})
	c.waitEvent("auth_success", 5*time.Second)
	// achtergebleven shell (bv. na een crash) van deze daemon, en een van een andere instance
	mine := map[string]string{"panel.test": "true", "panel.managed": "true", "panel.instance": "unit", "panel.role": "shell", "panel.server_uuid": u1}
	theirs := map[string]string{"panel.managed": "true", "panel.instance": "ander", "panel.role": "shell", "panel.server_uuid": u1}
	if _, err := eng.Create(t.Context(), engine.ContainerConfig{Name: server.ShellName(u1, "dead0001"), Labels: mine}); err != nil {
		t.Fatal(err)
	}
	if _, err := eng.Create(t.Context(), engine.ContainerConfig{Name: server.ShellName(u1, "other001"), Labels: theirs}); err != nil {
		t.Fatal(err)
	}
	c.conn.Close()
	h.restart()
	if eng.Container(server.ShellName(u1, "dead0001")) != nil {
		t.Fatal("verweesde shell niet opgeruimd")
	}
	if eng.Container(server.ShellName(u1, "other001")) == nil {
		t.Fatal("shell van een andere instance aangeraakt")
	}
	// server verwijderen sluit zijn shells
	c = h.term(u1)
	c.json(map[string]any{"event": "auth", "token": h.termToken(u1)})
	c.waitEvent("auth_success", 5*time.Second)
	h.expect("DELETE", "/api/servers/"+u1, nil, 204)
	c.waitClosed(5 * time.Second)
	for _, sc := range shellContainers(eng, u1) {
		if sc.Config.Labels["panel.instance"] == "unit" {
			t.Fatal("shell bleef na verwijderen")
		}
	}
}

func TestTerminalIdleTimeout(t *testing.T) {
	eng := engine.NewFake()
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", func(_ *config.Config, d *Deps) { d.TerminalIdle = 300 * time.Millisecond })
	sp := testSpec(u1)
	sp["skip_install"] = true
	h.expect("POST", "/api/servers", sp, 202)
	c := h.term(u1)
	c.json(map[string]any{"event": "auth", "token": h.termToken(u1)})
	c.waitEvent("auth_success", 5*time.Second)
	if code := c.waitClosed(5 * time.Second); code != 4009 {
		t.Fatalf("idle: %d", code)
	}
	waitFor(t, "opgeruimd", 5*time.Second, func() bool { return len(shellContainers(eng, u1)) == 0 })
}

func TestSSHShell(t *testing.T) {
	h, eng := newTermHarness(t)
	h.panel.AddSFTPUser("dev.0b7c2d1e", testpanel.SFTPUser{Password: "goed", Server: u1, Permissions: []string{"files.read", "files.write", "terminal"}})
	h.panel.AddSFTPUser("lezer.0b7c2d1e", testpanel.SFTPUser{Password: "goed", Server: u1, Permissions: []string{"files.read", "terminal"}})
	dial := func(user string) *ssh.Session {
		c, err := ssh.Dial("tcp", h.d.SFTPAddr(), &ssh.ClientConfig{User: user, Auth: []ssh.AuthMethod{ssh.Password("goed")}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		s, err := c.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	s := dial("dev.0b7c2d1e")
	if err := s.RequestPty("xterm", 30, 100, ssh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	in, _ := s.StdinPipe()
	out, _ := s.StdoutPipe()
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var buf strings.Builder
	go func() {
		b := make([]byte, 1024)
		for {
			n, err := out.Read(b)
			mu.Lock()
			buf.Write(b[:n])
			mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	has := func(sub string) func() bool {
		return func() bool { mu.Lock(); defer mu.Unlock(); return strings.Contains(buf.String(), sub) }
	}
	waitFor(t, "prompt", 5*time.Second, has("$ "))
	list := shellContainers(eng, u1)
	if len(list) != 1 {
		t.Fatalf("%d shells", len(list))
	}
	if rows, cols, _ := eng.TTYSize(list[0].ID); rows != 30 || cols != 100 {
		t.Fatalf("pty %d×%d", cols, rows)
	}
	if err := s.WindowChange(20, 90); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "window-change", 2*time.Second, func() bool { r, c, _ := eng.TTYSize(list[0].ID); return r == 20 && c == 90 })
	_, _ = io.WriteString(in, "ls\n")
	waitFor(t, "echo", 5*time.Second, has("out:ls"))
	_, _ = io.WriteString(in, "fail\n")
	err := s.Wait()
	if ee, ok := err.(*ssh.ExitError); !ok || ee.ExitStatus() != 3 {
		t.Fatalf("exit: %v", err)
	}
	waitFor(t, "opgeruimd", 5*time.Second, func() bool { return len(shellContainers(eng, u1)) == 0 })

	// zonder files.write geen shell (SFTP blijft werken)
	s2 := dial("lezer.0b7c2d1e")
	if err := s2.Shell(); err == nil {
		t.Fatal("shell zonder files.write")
	}
	// exec wordt geweigerd
	s3 := dial("dev.0b7c2d1e")
	if err := s3.Run("id"); err == nil {
		t.Fatal("exec toegestaan")
	}
	if n := len(shellContainers(eng, u1)); n != 0 {
		t.Fatalf("%d shells", n)
	}
}
