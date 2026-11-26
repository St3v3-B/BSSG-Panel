package proxy

// Tests tegen een echte Caddy (caddy:2) in Docker met de basisconfig uit
// deploy/caddy/ en `local_certs` (tls internal). Alles krijgt panel.test=true en
// een eigen panel.instance; opruimen gebeurt alleen op die twee labels samen.
// Overslaan: go test -short, PANEL_SKIP_DOCKER_TESTS=1, of geen Docker.

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
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
)

type caddyEnv struct {
	t        *testing.T
	inst     string
	caddy    string // containernaam
	admin    string // http://127.0.0.1:port
	httpAddr string
	tlsAddr  string
	siteNet  string
	siteCtr  string
	roots    *x509.CertPool
	client   *http.Client // volgt geen redirects
}

func dockerCmd(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func dockerAvailable() bool {
	return exec.Command("docker", "version", "--format", "{{.Server.Version}}").Run() == nil
}

func setupCaddy(t *testing.T) *caddyEnv {
	t.Helper()
	if testing.Short() || os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("Docker-tests overgeslagen")
	}
	if !dockerAvailable() {
		t.Skip("geen Docker")
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	e := &caddyEnv{t: t, inst: fmt.Sprintf("web-hosting-%d-%s", os.Getpid(), hex.EncodeToString(b))}
	labels := []string{"--label", "panel.test=true", "--label", "panel.instance=" + e.inst}
	t.Cleanup(e.cleanup)

	caddyfile, err := filepath.Abs("../../deploy/caddy/Caddyfile")
	if err != nil {
		t.Fatal(err)
	}
	example, err := os.ReadFile("../../deploy/caddy/examples/local-certs.caddy")
	if err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	globalD := filepath.Join(tmp, "global.d")
	runDir := filepath.Join(tmp, "run")
	for _, d := range []string{globalD, runDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(globalD, "local-certs.caddy"), example, 0o644); err != nil {
		t.Fatal(err)
	}
	startDaemonSocket(t, filepath.Join(runDir, "daemon.sock"))

	// Basisnetwerk zonder panel.managed: zo hoort het compose-netwerk niet bij de
	// netwerken die de router mag loskoppelen.
	base := e.inst + "-base"
	dockerCmd(t, append(append([]string{"network", "create"}, labels...), base)...)
	e.siteNet = e.inst + "-site"
	dockerCmd(t, append(append([]string{"network", "create", "--internal", "--label", "panel.managed=true"}, labels...), e.siteNet)...)

	dockerCmd(t, append(append([]string{"run", "-d", "--name", e.inst + "-panel", "--network", base, "--network-alias", "panel"}, labels...), "traefik/whoami", "--port", "3000", "--name", "panel-echo")...)
	e.siteCtr = e.inst + "-site1"
	dockerCmd(t, append(append([]string{"run", "-d", "--name", e.siteCtr, "--network", e.siteNet}, labels...), "traefik/whoami", "--port", "80", "--name", "site1-echo")...)

	// Vaste vrije poorten (niet door Docker gekozen): die blijven gelijk na een herstart.
	adminAddr, httpAddr, tlsAddr := freeAddr(t), freeAddr(t), freeAddr(t)
	e.caddy = e.inst + "-caddy"
	dockerCmd(t, append(append([]string{"run", "-d", "--name", e.caddy, "--network", base,
		"-p", adminAddr + ":2019", "-p", httpAddr + ":80", "-p", tlsAddr + ":443",
		"-e", "PANEL_DOMAIN=panel.test", "-e", "NODE_DOMAIN=node1.test", "-e", "ACME_EMAIL=admin@panel.test",
		"-v", caddyfile + ":/etc/caddy/Caddyfile:ro",
		"-v", globalD + ":/etc/caddy/global.d:ro",
		"-v", runDir + ":/run/panel"}, labels...), "caddy:2")...)
	e.admin, e.httpAddr, e.tlsAddr = "http://"+adminAddr, httpAddr, tlsAddr
	e.waitAdmin(t)

	e.roots = e.localRoots()
	e.client = &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				_, port, _ := net.SplitHostPort(addr)
				target := e.tlsAddr
				if port == "80" {
					target = e.httpAddr
				}
				return (&net.Dialer{}).DialContext(ctx, network, target)
			},
			TLSClientConfig:   &tls.Config{RootCAs: e.roots},
			DisableKeepAlives: true,
		},
	}
	return e
}

func (e *caddyEnv) cleanup() {
	f := []string{"--filter", "label=panel.test=true", "--filter", "label=panel.instance=" + e.inst}
	if ids, _ := exec.Command("docker", append([]string{"ps", "-aq"}, f...)...).Output(); len(strings.TrimSpace(string(ids))) > 0 {
		_ = exec.Command("docker", append([]string{"rm", "-f"}, strings.Fields(string(ids))...)...).Run()
	}
	if ids, _ := exec.Command("docker", append([]string{"network", "ls", "-q"}, f...)...).Output(); len(strings.TrimSpace(string(ids))) > 0 {
		_ = exec.Command("docker", append([]string{"network", "rm"}, strings.Fields(string(ids))...)...).Run()
	}
}

// freeAddr geeft een vrij adres op 127.0.0.1 (nooit 80, 443 of 2019).
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

func (e *caddyEnv) waitAdmin(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(e.admin + "/config/apps/http/servers/panel/routes")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	logs, _ := exec.Command("docker", "logs", e.caddy).CombinedOutput()
	t.Fatalf("Caddy-admin niet bereikbaar\n%s", logs)
}

func (e *caddyEnv) localRoots() *x509.CertPool {
	e.t.Helper()
	resp, err := http.Get(e.admin + "/pki/ca/local")
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var ca struct {
		Root string `json:"root_certificate"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ca); err != nil {
		e.t.Fatal(err)
	}
	blk, _ := pem.Decode([]byte(ca.Root))
	if blk == nil {
		e.t.Fatal("geen root-certificaat van Caddy")
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		e.t.Fatal(err)
	}
	p := x509.NewCertPool()
	p.AddCert(cert)
	return p
}

func (e *caddyEnv) router() *Caddy {
	e.t.Helper()
	c, err := NewCaddyWithOptions(Config{AdminURL: e.admin, CaddyContainer: e.caddy, Instance: e.inst}, CaddyOptions{TLSAddr: e.tlsAddr})
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// get doet een request en geeft status, Location en body; herhaalt tot ok() of
// de deadline (certificaten en config-reloads hebben even nodig).
func (e *caddyEnv) get(t *testing.T, url string, ok func(int, string, string) bool) (int, string, string) {
	t.Helper()
	var code int
	var loc, body string
	var lastErr error
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := e.client.Get(url)
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			code, loc, body = resp.StatusCode, resp.Header.Get("Location"), string(b)
			if ok(code, loc, body) {
				return code, loc, body
			}
		}
		lastErr = err
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("GET %s: geen goed antwoord: %d %q %.200q (laatste fout: %v)", url, code, loc, body, lastErr)
	return 0, "", ""
}

func (e *caddyEnv) caddyNetworks(t *testing.T) string {
	return dockerCmd(t, "inspect", "-f", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", e.caddy)
}

// startDaemonSocket is een nep-daemon op een unix-socket: "/" geeft het pad terug,
// "/ws" doet een websocket-handshake en echoot daarna regels.
func startDaemonSocket(t *testing.T, path string) {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(path, 0o666)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" {
			fmt.Fprintf(w, "daemon %s host=%s", r.URL.Path, r.Host)
			return
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "upgrade required", http.StatusUpgradeRequired)
			return
		}
		h := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		conn, brw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		fmt.Fprintf(brw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(h[:]))
		_ = brw.Flush()
		for {
			line, err := brw.ReadString('\n')
			if err != nil {
				return
			}
			_, _ = brw.WriteString("echo " + line)
			_ = brw.Flush()
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
}

func TestDockerCaddy(t *testing.T) {
	e := setupCaddy(t)
	ctx := context.Background()
	c := e.router()

	t.Run("panel-domein met geldig certificaat", func(t *testing.T) {
		_, _, body := e.get(t, "https://panel.test/hallo", func(code int, _, b string) bool { return code == 200 })
		if !strings.Contains(body, "Name: panel-echo") || !strings.Contains(body, "GET /hallo") {
			t.Fatalf("onverwacht antwoord van het panel: %s", body)
		}
	})

	t.Run("daemon-domein via unix-socket", func(t *testing.T) {
		_, _, body := e.get(t, "https://node1.test/api/system", func(code int, _, b string) bool { return code == 200 })
		if body != "daemon /api/system host=node1.test" {
			t.Fatalf("onverwacht antwoord van de daemon: %q", body)
		}
	})

	t.Run("websocket naar de daemon", func(t *testing.T) {
		conn, err := tls.Dial("tcp", e.tlsAddr, &tls.Config{ServerName: "node1.test", RootCAs: e.roots, NextProtos: []string{"http/1.1"}})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		fmt.Fprint(conn, "GET /ws HTTP/1.1\r\nHost: node1.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
		br := bufio.NewReader(conn)
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("status %d", resp.StatusCode)
		}
		fmt.Fprint(conn, "ping\n")
		line, err := br.ReadString('\n')
		if err != nil || line != "echo ping\n" {
			t.Fatalf("echo = %q, %v", line, err)
		}
	})

	t.Run("http naar https", func(t *testing.T) {
		code, loc, _ := e.get(t, "http://panel.test/a?b=1", func(code int, _, _ string) bool { return code/100 == 3 })
		if code != http.StatusPermanentRedirect || loc != "https://panel.test/a?b=1" {
			t.Fatalf("redirect = %d %q", code, loc)
		}
	})

	t.Run("route met netwerk, redirect en status", func(t *testing.T) {
		if err := c.SetRoute(ctx, Route{Host: "Site.Test", ServerUUID: "u1", Upstream: Upstream{Container: e.siteCtr, Network: e.siteNet, Port: 80}}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(e.caddyNetworks(t), e.siteNet) {
			t.Fatalf("Caddy niet gekoppeld aan %s: %s", e.siteNet, e.caddyNetworks(t))
		}
		_, _, body := e.get(t, "https://site.test/x", func(code int, _, b string) bool { return code == 200 })
		if !strings.Contains(body, "Name: site1-echo") {
			t.Fatalf("site antwoordt niet: %s", body)
		}
		if err := c.SetRoute(ctx, Route{Host: "www.site.test", RedirectTo: "site.test"}); err != nil {
			t.Fatal(err)
		}
		code, loc, _ := e.get(t, "https://www.site.test/a/b?c=d", func(code int, _, _ string) bool { return code == 308 })
		if code != 308 || loc != "https://site.test/a/b?c=d" {
			t.Fatalf("redirect = %d %q", code, loc)
		}
		var st RouteStatus
		var err error
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if st, err = c.Status(ctx, "site.test"); err == nil && st.SSL == SSLActive {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if err != nil || st.SSL != SSLActive {
			t.Fatalf("status = %+v, %v", st, err)
		}
		if _, err := c.Status(ctx, "nope.test"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("verwacht ErrNotFound, kreeg %v", err)
		}
	})

	t.Run("sync haalt weg, vaste routes blijven", func(t *testing.T) {
		if err := c.Sync(ctx, []Route{{Host: "www.site.test", RedirectTo: "elders.test"}}); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(e.caddyNetworks(t), e.siteNet) {
			t.Fatalf("Caddy nog gekoppeld aan %s na de laatste route", e.siteNet)
		}
		if !strings.Contains(e.caddyNetworks(t), e.inst+"-base") {
			t.Fatal("basisnetwerk is losgekoppeld")
		}
		code, loc, _ := e.get(t, "https://www.site.test/", func(code int, loc, _ string) bool { return loc == "https://elders.test/" })
		if code != 308 {
			t.Fatalf("redirect = %d %q", code, loc)
		}
		if _, err := e.client.Get("https://site.test/"); err == nil {
			t.Fatal("site.test is nog bereikbaar na Sync")
		}
		e.get(t, "https://panel.test/", func(code int, _, _ string) bool { return code == 200 })
		e.get(t, "https://node1.test/", func(code int, _, _ string) bool { return code == 200 })
	})

	t.Run("caddy-herstart, healthy en herstel via sync", func(t *testing.T) {
		routes := []Route{{Host: "site.test", Upstream: Upstream{Container: e.siteCtr, Network: e.siteNet, Port: 80}}}
		if err := c.Sync(ctx, routes); err != nil {
			t.Fatal(err)
		}
		e.get(t, "https://site.test/", func(code int, _, _ string) bool { return code == 200 })
		if err := c.Healthy(ctx); err != nil {
			t.Fatal(err)
		}
		dockerCmd(t, "restart", "-t", "2", e.caddy)
		e.waitAdmin(t)
		if err := c.Healthy(ctx); err == nil {
			t.Fatal("Healthy moet na een herstart één keer falen")
		}
		if err := c.Healthy(ctx); err != nil {
			t.Fatalf("Healthy na de fout: %v", err)
		}
		if resp, err := e.client.Get("https://site.test/"); err == nil {
			resp.Body.Close()
			t.Fatal("site.test zou na de herstart weg moeten zijn")
		}
		if err := c.Sync(ctx, routes); err != nil {
			t.Fatal(err)
		}
		e.get(t, "https://site.test/", func(code int, _, _ string) bool { return code == 200 })
		e.get(t, "https://panel.test/", func(code int, _, _ string) bool { return code == 200 })
	})

	t.Run("opruimen: laatste route weg koppelt los", func(t *testing.T) {
		if err := c.RemoveRoute(ctx, "site.test"); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(e.caddyNetworks(t), e.siteNet) {
			t.Fatal("Caddy nog gekoppeld na RemoveRoute van de laatste route")
		}
	})
}
