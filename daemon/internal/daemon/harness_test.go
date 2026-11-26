package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/server"
	"panel/daemon/internal/testpanel"
	"panel/daemon/proxy"
)

const nodeToken = "node-token-test"

type harness struct {
	t      *testing.T
	d      *Daemon
	eng    engine.Engine
	router proxy.Router
	panel  *testpanel.Panel
	cfg    config.Config
	base   string
	deps   Deps
}

func testLogger(t *testing.T) *slog.Logger {
	if os.Getenv("DAEMON_TEST_LOG") == "1" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newHarness start een daemon tegen eng met een nep-panel. dataDir mag leeg zijn.
func newHarness(t *testing.T, eng engine.Engine, router proxy.Router, p *testpanel.Panel, dataDir string, extra map[string]string, instance string) *harness {
	t.Helper()
	if p == nil {
		p = testpanel.New(nodeToken, "node1.test")
		t.Cleanup(p.Close)
	}
	if dataDir == "" {
		dataDir = t.TempDir()
	}
	if router == nil {
		router = proxy.NewFake()
	}
	if instance == "" {
		instance = "unit"
	}
	cfg := config.Config{
		NodeToken: nodeToken, NodeDomain: "node1.test", PanelDomain: "panel.test", PanelURL: p.URL,
		DaemonSocket: filepath.Join(dataDir, "daemon.sock"), DaemonPort: 0, DataDir: dataDir,
		Instance: instance, ExtraLabels: extra,
	}
	log := testLogger(t)
	pc := panel.New(p.URL, nodeToken, log)
	pc.MinBackoff, pc.MaxBackoff, pc.MaxRetry = 5*time.Millisecond, 50*time.Millisecond, 5*time.Second
	deps := Deps{
		Engine: eng, Router: router, Log: log, Version: "test", Panel: pc,
		Server:        server.Config{StopTimeout: 3 * time.Second, DiskInterval: 200 * time.Millisecond, StatsInterval: 100 * time.Millisecond},
		WSAuthTimeout: 500 * time.Millisecond,
		SFTPAddr:      "127.0.0.1:0", SFTPFailDelay: 10 * time.Millisecond,
	}
	h := &harness{t: t, eng: eng, router: router, panel: p, cfg: cfg, deps: deps}
	h.start()
	t.Cleanup(h.stop)
	return h
}

func (h *harness) start() {
	h.t.Helper()
	d, err := New(h.cfg, h.deps)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := d.Start(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	h.d = d
	h.base = "http://" + d.TCPAddr()
}

func (h *harness) stop() {
	if h.d != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.d.Shutdown(ctx)
		h.d.panel.Wait()
		h.d = nil
	}
}

func (h *harness) restart() {
	h.stop()
	h.start()
}

type resp struct {
	Code int
	Body []byte
}

func (r resp) json(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		t.Fatalf("json: %v: %s", err, r.Body)
	}
}

func (h *harness) do(method, path string, body any) resp {
	h.t.Helper()
	return h.doTok(method, path, body, nodeToken)
}

func (h *harness) doTok(method, path string, body any, tok string) resp {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.base+path, rd)
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 && res.Header.Get("Content-Type") != "application/json" {
		h.t.Fatalf("%s %s: foutantwoord zonder JSON (%d): %s", method, path, res.StatusCode, b)
	}
	return resp{res.StatusCode, b}
}

func (h *harness) expect(method, path string, body any, code int) resp {
	h.t.Helper()
	r := h.do(method, path, body)
	if r.Code != code {
		h.t.Fatalf("%s %s: %d, verwacht %d: %s", method, path, r.Code, code, r.Body)
	}
	return r
}

func (h *harness) state(uuid string) server.View {
	h.t.Helper()
	var v server.View
	h.expect("GET", "/api/servers/"+uuid, nil, 200).json(h.t, &v)
	return v
}

func (h *harness) waitState(uuid, want string, timeout time.Duration) server.View {
	h.t.Helper()
	var v server.View
	waitFor(h.t, "state "+want, timeout, func() bool {
		v = h.state(uuid)
		return v.State == want
	})
	return v
}

func waitFor(t *testing.T, what string, timeout time.Duration, fn func() bool) {
	t.Helper()
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout: %s", what)
}

// ---------- websocket-client ----------

type wsClient struct {
	t      *testing.T
	conn   *websocket.Conn
	msgs   chan map[string]any
	closed chan int
	seen   []map[string]any
}

func (h *harness) ws(uuid string, header http.Header) *wsClient {
	h.t.Helper()
	url := "ws://" + h.d.TCPAddr() + "/api/servers/" + uuid + "/ws"
	conn, res, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		code := 0
		if res != nil {
			code = res.StatusCode
		}
		h.t.Fatalf("ws dial: %v (%d)", err, code)
	}
	c := &wsClient{t: h.t, conn: conn, msgs: make(chan map[string]any, 10000), closed: make(chan int, 1)}
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				code := -1
				if ce, ok := err.(*websocket.CloseError); ok {
					code = ce.Code
				}
				c.closed <- code
				close(c.msgs)
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			c.msgs <- m
		}
	}()
	h.t.Cleanup(func() { conn.Close() })
	return c
}

func (c *wsClient) send(v any) {
	c.t.Helper()
	if err := c.conn.WriteJSON(v); err != nil {
		c.t.Fatal(err)
	}
}

// next wacht op een bericht dat pred matcht.
func (c *wsClient) next(what string, timeout time.Duration, pred func(map[string]any) bool) map[string]any {
	c.t.Helper()
	tm := time.After(timeout)
	for {
		select {
		case m, ok := <-c.msgs:
			if !ok {
				c.t.Fatalf("ws gesloten tijdens wachten op %s", what)
			}
			c.seen = append(c.seen, m)
			if pred(m) {
				return m
			}
		case <-tm:
			c.t.Fatalf("timeout op ws-bericht: %s (gezien: %v)", what, summarize(c.seen))
		}
	}
}

func summarize(ms []map[string]any) string {
	var parts []string
	for i, m := range ms {
		if i > 30 {
			parts = append(parts, "...")
			break
		}
		parts = append(parts, fmt.Sprintf("%v:%v%v", m["event"], m["line"], m["state"]))
	}
	return strings.Join(parts, " | ")
}

func ev(name string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["event"] == name }
}

func lineMatch(event, substr string) func(map[string]any) bool {
	return func(m map[string]any) bool {
		l, _ := m["line"].(string)
		return m["event"] == event && strings.Contains(l, substr)
	}
}

func (c *wsClient) waitClosed(timeout time.Duration) int {
	c.t.Helper()
	for {
		select {
		case _, ok := <-c.msgs:
			if !ok {
				return <-c.closed
			}
		case <-time.After(timeout):
			c.t.Fatal("ws niet gesloten")
			return 0
		}
	}
}

// ---------- specs ----------

func testSpec(uuid string) map[string]any {
	return map[string]any{
		"uuid": uuid, "type": "game", "image": "fake/server:1",
		"startup": "run --mem {{SERVER_MEMORY}}", "stop": map[string]string{"type": "command", "value": "stop"},
		"ready_pattern": `Done \(`, "environment": map[string]string{"FOO": "bar"},
		"limits":      map[string]any{"cpu_pct": 100, "memory_mb": 512, "swap_mb": 0, "disk_mb": 1024},
		"allocations": []map[string]any{{"ip": "127.0.0.1", "port": 25565, "primary": true}},
		"install":     map[string]string{"image": "fake/install:1", "script": "echo install"},
		"config_files": []map[string]any{{"path": "server.properties", "format": "properties",
			"set": map[string]string{"server-port": "{{SERVER_PORT}}", "foo": "{{FOO}}"}}},
	}
}
