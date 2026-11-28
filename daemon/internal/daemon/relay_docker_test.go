package daemon

// HTTP(S)-relay met twee echte daemons en twee echte Caddy's (caddy:2 in Docker, `tls internal`):
// node1.test (A, edge) heeft Caddy op eigen poorten (de basisconfig deploy/caddy/Caddyfile.node);
// node2.test (B) heeft Caddy zonder publieke poorten (deploy/caddy/relay-client.json) en een
// uitgaande tunnel naar A. Alle Docker-objecten krijgen panel.test=true en een eigen panel.instance.

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/testpanel"
	"panel/daemon/proxy"
)

func relayDocker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func relayFreeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

func waitCaddyAdmin(t *testing.T, sock, name string) *http.Client {
	t.Helper()
	hc := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if res, err := hc.Get("http://caddy/config/apps/http/servers/panel/routes"); err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return hc
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	logs, _ := exec.Command("docker", "logs", name).CombinedOutput()
	t.Fatalf("Caddy %s: admin niet bereikbaar\n%s", name, logs)
	return nil
}

func caddyLocalRoots(t *testing.T, hc *http.Client) *x509.CertPool {
	t.Helper()
	res, err := hc.Get("http://caddy/pki/ca/local")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var ca struct {
		Root string `json:"root_certificate"`
	}
	if err := json.NewDecoder(res.Body).Decode(&ca); err != nil {
		t.Fatal(err)
	}
	p := x509.NewCertPool()
	if !p.AppendCertsFromPEM([]byte(ca.Root)) {
		t.Fatal("geen root")
	}
	return p
}

func TestRealDockerRelay(t *testing.T) {
	if testing.Short() || os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("Docker-tests overgeslagen")
	}
	if exec.Command("docker", "version").Run() != nil {
		t.Skip("geen Docker")
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	inst := fmt.Sprintf("relay-%d-%s", os.Getpid(), hex.EncodeToString(b))
	labels := []string{"--label", "panel.test=true", "--label", "panel.instance=" + inst}
	t.Cleanup(func() {
		f := []string{"--filter", "label=panel.test=true", "--filter", "label=panel.instance=" + inst}
		if ids, _ := exec.Command("docker", append([]string{"ps", "-aq"}, f...)...).Output(); len(strings.TrimSpace(string(ids))) > 0 {
			_ = exec.Command("docker", append([]string{"rm", "-f"}, strings.Fields(string(ids))...)...).Run()
		}
		if ids, _ := exec.Command("docker", append([]string{"network", "ls", "-q"}, f...)...).Output(); len(strings.TrimSpace(string(ids))) > 0 {
			_ = exec.Command("docker", append([]string{"network", "rm"}, strings.Fields(string(ids))...)...).Run()
		}
	})
	abs := func(p string) string {
		a, err := filepath.Abs(p)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	tmp, err := os.MkdirTemp("", "relay-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	runA, runB, globalD := filepath.Join(tmp, "a"), filepath.Join(tmp, "b"), filepath.Join(tmp, "global.d")
	for _, d := range []string{runA, runB, globalD} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	example, err := os.ReadFile("../../../deploy/caddy/examples/local-certs.caddy")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(globalD, "local-certs.caddy"), example, 0o644); err != nil {
		t.Fatal(err)
	}

	// ---- Caddy A (edge): eigen poorten, basisconfig van een node ----
	httpA, tlsA := relayFreeAddr(t), relayFreeAddr(t)
	caddyA := inst + "-caddy-a"
	relayDocker(t, append(append([]string{"run", "-d", "--name", caddyA, "-p", httpA + ":80", "-p", tlsA + ":443",
		"-e", "NODE_DOMAIN=node1.test", "-e", "ACME_EMAIL=admin@panel.test",
		"-v", abs("../../../deploy/caddy/Caddyfile.node") + ":/etc/caddy/Caddyfile:ro",
		"-v", globalD + ":/etc/caddy/global.d:ro", "-v", runA + ":/run/panel"}, labels...), "caddy:2")...)
	hcA := waitCaddyAdmin(t, filepath.Join(runA, "caddy-admin.sock"), caddyA)
	rootsA := caddyLocalRoots(t, hcA)

	// ---- Caddy B: geen publieke poorten, alleen de relay-socket; een site op een eigen netwerk ----
	siteNet := inst + "-site"
	relayDocker(t, append(append([]string{"network", "create", "--internal", "--label", "panel.managed=true", "--label", "panel.role=site"}, labels...), siteNet)...)
	site := inst + "-site1"
	relayDocker(t, append(append([]string{"run", "-d", "--name", site, "--network", siteNet}, labels...), "traefik/whoami", "--port", "80", "--name", "site-on-node2")...)
	caddyB := inst + "-caddy-b"
	relayDocker(t, append(append([]string{"run", "-d", "--name", caddyB,
		"-v", abs("../../../deploy/caddy/relay-client.json") + ":/etc/caddy/relay.json:ro", "-v", runB + ":/run/panel"}, labels...),
		"caddy:2", "caddy", "run", "--config", "/etc/caddy/relay.json")...)
	waitCaddyAdmin(t, filepath.Join(runB, "caddy-admin.sock"), caddyB)

	const secret = "relay-secret-for-tests-0123456789"
	// Alle *.test-namen wijzen (zoals DNS in productie) naar de 443 van A; 127.0.0.1:<poort> blijft zichzelf.
	dialA := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if h, _, _ := net.SplitHostPort(addr); strings.HasSuffix(h, ".test") {
			addr = tlsA
		}
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}

	// ---- daemon A ----
	routerA, err := proxy.NewCaddyWithOptions(proxy.Config{AdminURL: "unix://" + filepath.Join(runA, "caddy-admin.sock"), Instance: inst},
		proxy.CaddyOptions{TLSAddr: tlsA, ExtraRoots: rootsA, NodeIPs: []net.IP{net.ParseIP("127.0.0.1")}})
	if err != nil {
		t.Fatal(err)
	}
	panelA := testpanel.New(nodeToken, "node1.test")
	t.Cleanup(panelA.Close)
	clientCfg := func(hosts ...string) map[string]any {
		var hs []map[string]any
		for _, h := range hosts {
			hs = append(hs, map[string]any{"host": h, "wildcard": false, "dns_challenge": nil})
		}
		return map[string]any{"edge": nil, "clients": []map[string]any{{"node_id": 2, "fqdn": "node2.test", "secret": secret, "hosts": hs}}}
	}
	panelA.SetRelay(clientCfg("site.node2.test"))
	a := newHarnessWith(t, engine.NewFake(), routerA, panelA, filepath.Join(tmp, "data-a"), nil, inst+"-a", func(c *config.Config, d *Deps) {
		c.DaemonSocket = filepath.Join(runA, "daemon.sock")
		c.RelaySocket = filepath.Join(runA, "relay.sock")
		c.RelayCaddyDial = "unix//run/panel/relay.sock"
		d.SyncInterval, d.HealthInterval = time.Hour, time.Hour
		d.RelayPing = 200 * time.Millisecond
	})

	// ---- daemon B ----
	routerB, err := proxy.NewCaddyWithOptions(proxy.Config{AdminURL: "unix://" + filepath.Join(runB, "caddy-admin.sock"), CaddyContainer: caddyB, Instance: inst}, proxy.CaddyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	panelB := testpanel.New(nodeToken, "node2.test")
	t.Cleanup(panelB.Close)
	edgeCfg := func(url, sec string) map[string]any {
		return map[string]any{"clients": []any{}, "edge": map[string]any{"node_id": 1, "url": url, "fqdn": "node1.test", "client_id": 2, "secret": sec}}
	}
	panelB.SetRelay(edgeCfg("https://node1.test", secret))
	bh := newHarnessWith(t, engine.NewFake(), routerB, panelB, filepath.Join(tmp, "data-b"), nil, inst+"-b", func(c *config.Config, d *Deps) {
		c.NodeDomain = "node2.test"
		c.DaemonSocket = filepath.Join(runB, "daemon.sock")
		c.RelayWebUpstream = "unix://" + filepath.Join(runB, "caddy-relay.sock")
		c.HTTPMode = "relay"
		d.Version = "daemon-b"
		d.SyncInterval, d.HealthInterval = time.Hour, time.Hour
		d.RelayRoots, d.RelayDial = rootsA, dialA
		d.RelayMinBackoff, d.RelayMaxBackoff, d.RelayPing = 50*time.Millisecond, 300*time.Millisecond, 200*time.Millisecond
	})
	// De site op B: een gewone dynamische route in B's Caddy (B koppelt zijn Caddy aan het sitenetwerk).
	if err := routerB.SetRoute(context.Background(), proxy.Route{Host: "site.node2.test", Upstream: proxy.Upstream{Container: site, Network: siteNet, Port: 80}}); err != nil {
		t.Fatal(err)
	}

	// Browser/panel: alles via de 443 van A.
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DialContext: dialA, TLSClientConfig: &tls.Config{RootCAs: rootsA}, DisableKeepAlives: true}}
	get := func(url string, tok string) (int, string, error) {
		req, _ := http.NewRequest("GET", url, nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		res, err := client.Do(req)
		if err != nil {
			return 0, "", err
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(body), nil
	}
	waitOK := func(what, url, tok, want string) {
		t.Helper()
		var code int
		var body string
		var err error
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			code, body, err = get(url, tok)
			if err == nil && code == 200 && strings.Contains(body, want) {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		logs, _ := exec.Command("docker", "logs", "--tail", "30", caddyA).CombinedOutput()
		t.Fatalf("%s: %d %q %v\nCaddy A:\n%s", what, code, body, err, logs)
	}

	t.Run("site op B via A", func(t *testing.T) {
		waitOK("site", "https://site.node2.test/hallo", "", "Name: site-on-node2")
	})

	t.Run("node-API van B via A", func(t *testing.T) {
		waitOK("system", "https://node2.test/api/system", nodeToken, `"version":"daemon-b"`)
		if code, _, err := get("https://node2.test/api/system", "fout"); err != nil || code != 401 {
			t.Fatal("token wordt door B gecontroleerd", code, err)
		}
		// A's eigen API blijft A.
		waitOK("system A", "https://node1.test/api/system", nodeToken, `"version":"test"`)
	})

	t.Run("console-websocket van B via A", func(t *testing.T) {
		sp := testSpec(u1)
		sp["start_on_install"] = true
		bh.expect("POST", "/api/servers", sp, 202)
		bh.waitState(u1, "online", 10*time.Second)
		d := websocket.Dialer{NetDialContext: dialA, TLSClientConfig: &tls.Config{RootCAs: rootsA}, HandshakeTimeout: 10 * time.Second}
		ws, res, err := d.Dial("wss://node2.test/api/servers/"+u1+"/ws", http.Header{"Origin": {"https://panel.test"}})
		if err != nil {
			code := 0
			if res != nil {
				code = res.StatusCode
			}
			t.Fatal(err, code)
		}
		defer ws.Close()
		_ = ws.WriteJSON(map[string]any{"event": "auth", "token": panelB.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read", "console.write"}})})
		seen := map[string]bool{}
		_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
		for !(seen["auth_success"] && seen["done"]) {
			var m map[string]any
			if err := ws.ReadJSON(&m); err != nil {
				t.Fatal(err, seen)
			}
			if m["event"] == "auth_success" {
				seen["auth_success"] = true
			}
			if l, _ := m["line"].(string); m["event"] == "console_output" && strings.Contains(l, "Done (") {
				seen["done"] = true
			}
		}
		_ = ws.WriteJSON(map[string]any{"event": "send_command", "command": "say via-relay"})
		for {
			var m map[string]any
			if err := ws.ReadJSON(&m); err != nil {
				t.Fatal(err)
			}
			if l, _ := m["line"].(string); strings.Contains(l, "via-relay") {
				break
			}
		}
	})

	t.Run("A weigert onbekende domeinen", func(t *testing.T) {
		// Geen route, geen certificaat in Caddy A.
		if code, body, err := get("https://evil.test/", ""); err == nil && code == 200 {
			t.Fatal("onbekend domein beantwoord", body)
		}
		// En de relay-socket zelf stuurt alleen toegewezen hostnamen door.
		hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(runA, "relay.sock"))
		}}}
		for _, h := range []string{"evil.test", "panel.test", "node1.test"} {
			req, _ := http.NewRequest("GET", "http://x/api/system", nil)
			req.Host = h
			res, err := hc.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != http.StatusMisdirectedRequest {
				t.Fatal(h, res.StatusCode)
			}
		}
	})

	t.Run("status en SSL bij A", func(t *testing.T) {
		var st struct {
			Clients []struct {
				NodeID    int      `json:"node_id"`
				Connected bool     `json:"connected"`
				LatencyMs *float64 `json:"latency_ms"`
				SSL       []struct {
					Host      string `json:"host"`
					SSLStatus string `json:"ssl_status"`
				} `json:"ssl"`
			} `json:"clients"`
		}
		waitFor(t, "status", 20*time.Second, func() bool {
			a.expect("GET", "/api/relay?ssl=1", nil, 200).json(t, &st)
			if len(st.Clients) != 1 || !st.Clients[0].Connected || st.Clients[0].LatencyMs == nil || len(st.Clients[0].SSL) != 2 {
				return false
			}
			for _, s := range st.Clients[0].SSL {
				if s.SSLStatus != "active" {
					return false
				}
			}
			return true
		})
		var bs struct {
			HTTPMode string `json:"http_mode"`
			Edge     *struct {
				Connected bool `json:"connected"`
			} `json:"edge"`
		}
		bh.expect("GET", "/api/relay", nil, 200).json(t, &bs)
		if bs.HTTPMode != "relay" || bs.Edge == nil || !bs.Edge.Connected {
			t.Fatalf("%+v", bs)
		}
		waitFor(t, "status naar panel", 5*time.Second, func() bool {
			for _, c := range panelB.Calls("/api/remote/relay/status") {
				if c.Body["connected"] == true {
					return true
				}
			}
			return false
		})
	})

	t.Run("nieuw domein: alleen na toewijzing door het panel", func(t *testing.T) {
		if err := routerB.SetRoute(context.Background(), proxy.Route{Host: "www.node2.test", Upstream: proxy.Upstream{Container: site, Network: siteNet, Port: 80}}); err != nil {
			t.Fatal(err)
		}
		if code, _, err := get("https://www.node2.test/", ""); err == nil && code == 200 {
			t.Fatal("niet toegewezen domein werd doorgestuurd")
		}
		panelA.SetRelay(clientCfg("site.node2.test", "www.node2.test"))
		a.expect("POST", "/api/relay/refresh", nil, 204)
		waitOK("www", "https://www.node2.test/", "", "Name: site-on-node2")
	})

	t.Run("tunnel herstelt na herstart van A", func(t *testing.T) {
		a.restart()
		waitOK("site na herstart", "https://site.node2.test/", "", "Name: site-on-node2")
		var bs struct {
			Edge struct {
				Connected  bool `json:"connected"`
				Reconnects int  `json:"reconnects"`
			} `json:"edge"`
		}
		bh.expect("GET", "/api/relay", nil, 200).json(t, &bs)
		if !bs.Edge.Connected || bs.Edge.Reconnects < 1 {
			t.Fatalf("%+v", bs)
		}
	})

	t.Run("B weigert een andere A", func(t *testing.T) {
		// Een tweede daemon die B niet als client kent (ander geheim): de tunnel komt niet op en B gebruikt hem niet.
		panelC := testpanel.New(nodeToken, "node3.test")
		t.Cleanup(panelC.Close)
		panelC.SetRelay(map[string]any{"clients": []map[string]any{{"node_id": 2, "fqdn": "node2.test", "secret": "other-secret", "hosts": []any{}}}})
		c := newHarnessWith(t, engine.NewFake(), nil, panelC, filepath.Join(tmp, "data-c"), nil, inst+"-c", func(c *config.Config, d *Deps) {
			c.NodeDomain = "node3.test"
			c.DaemonSocket = filepath.Join(tmp, "c.sock")
		})
		panelB.SetRelay(edgeCfg("http://"+c.d.TCPAddr(), secret))
		if err := bh.d.RelayRefresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		var bs struct {
			Edge struct {
				Connected bool    `json:"connected"`
				LastError *string `json:"last_error"`
			} `json:"edge"`
		}
		waitFor(t, "geweigerd", 10*time.Second, func() bool {
			bh.expect("GET", "/api/relay", nil, 200).json(t, &bs)
			return !bs.Edge.Connected && bs.Edge.LastError != nil && strings.Contains(*bs.Edge.LastError, "401")
		})
		// De oude edge A stuurt nu niets meer door (B is daar losgekoppeld).
		if code, body, err := get("https://site.node2.test/", ""); err == nil && code == 200 && strings.Contains(body, "site-on-node2") {
			t.Fatal("B mag niet meer via A bereikbaar zijn na het wisselen van edge")
		}
	})
}
