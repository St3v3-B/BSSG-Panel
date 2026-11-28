package proxy

// Test tegen een echte Nginx Proxy Manager (jc21/nginx-proxy-manager:latest) met daarachter een echte Caddy met
// deploy/caddy/Caddyfile.npm: NPM:80 → Caddy:80 (HTTP-only) → echo-container. Geen certificaten (nooit Let's
// Encrypt-productie): NPMOptions.NoCertificates. Alles krijgt panel.test=true + panel.instance=npm-<pid>-…;
// opruimen alleen op die twee labels samen. Overslaan: -short, PANEL_SKIP_DOCKER_TESTS=1, geen Docker of geen image.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRealNPM(t *testing.T) {
	if testing.Short() || os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("Docker-tests overgeslagen")
	}
	if !dockerAvailable() {
		t.Skip("geen Docker")
	}
	const image = "jc21/nginx-proxy-manager:latest"
	if exec.Command("docker", "image", "inspect", image).Run() != nil {
		if out, err := exec.Command("docker", "pull", image).CombinedOutput(); err != nil {
			t.Skipf("image %s niet te halen: %v\n%s", image, err, out)
		}
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	inst := fmt.Sprintf("npm-%d-%s", os.Getpid(), hex.EncodeToString(b))
	labels := []string{"--label", "panel.test=true", "--label", "panel.instance=" + inst}
	e := &caddyEnv{t: t, inst: inst}
	t.Cleanup(e.cleanup)

	caddyfile, err := filepath.Abs("../../deploy/caddy/Caddyfile.npm")
	if err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	runDir, globalD := filepath.Join(tmp, "run"), filepath.Join(tmp, "global.d")
	npmData, npmLE := filepath.Join(tmp, "npm-data"), filepath.Join(tmp, "npm-letsencrypt")
	for _, d := range []string{runDir, globalD, npmData, npmLE} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	startDaemonSocket(t, filepath.Join(runDir, "daemon.sock"))
	netName := inst + "-net"
	dockerCmd(t, append(append([]string{"network", "create"}, labels...), netName)...)
	echo := inst + "-echo"
	dockerCmd(t, append(append([]string{"run", "-d", "--name", echo, "--network", netName}, labels...), "traefik/whoami", "--port", "8080", "--name", "npm-echo")...)
	caddy := inst + "-caddy"
	dockerCmd(t, append(append([]string{"run", "-d", "--name", caddy, "--network", netName, "--memory", "128m",
		"-e", "NODE_DOMAIN=node1.test", "-v", caddyfile + ":/etc/caddy/Caddyfile:ro", "-v", globalD + ":/etc/caddy/global.d:ro",
		"-v", runDir + ":/run/panel"}, labels...), "caddy:2")...)
	adminAddr, httpAddr := freeAddr(t), freeAddr(t)
	npmCtr := inst + "-npm"
	dockerCmd(t, append(append([]string{"run", "-d", "--name", npmCtr, "--network", netName, "--memory", "512m",
		"-p", adminAddr + ":81", "-p", httpAddr + ":80", "-v", npmData + ":/data", "-v", npmLE + ":/etc/letsencrypt",
		"-e", "INITIAL_ADMIN_EMAIL=admin@panel.test", "-e", "INITIAL_ADMIN_PASSWORD=npm-test-password-1",
		"-e", "DISABLE_IPV6=true"}, labels...), image)...)

	e.caddy = caddy
	e.admin = "unix://" + filepath.Join(runDir, "caddy-admin.sock")
	if e.adminURL, e.adminHC, err = adminClient(e.admin, nil); err != nil {
		t.Fatal(err)
	}
	e.waitAdmin(t)
	inner, err := NewCaddyWithOptions(Config{AdminURL: e.admin, Instance: inst}, CaddyOptions{})
	if err != nil {
		t.Fatal(err)
	}

	npmURL := "http://" + adminAddr
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var res NPMTestResult
	for deadline := time.Now().Add(3 * time.Minute); time.Now().Before(deadline); time.Sleep(2 * time.Second) {
		res = TestNPM(ctx, NPMSettings{URL: npmURL, Email: "admin@panel.test", Password: "npm-test-password-1"}, inst, nil)
		if res.State == NPMStateOK {
			break
		}
		if st, _ := exec.Command("docker", "inspect", "-f", "{{.State.Running}}", npmCtr).Output(); strings.TrimSpace(string(st)) != "true" {
			break
		}
	}
	if res.State != NPMStateOK {
		logs, _ := exec.Command("docker", "logs", "--tail", "50", npmCtr).CombinedOutput()
		t.Fatalf("NPM not ready: %+v\n%s", res, logs)
	}
	t.Logf("NPM %s", res.Version)
	if r := TestNPM(ctx, NPMSettings{URL: npmURL, Email: "admin@panel.test", Password: "wrong-password"}, inst, nil); r.State != NPMStateLoginFailed {
		t.Fatalf("wrong password: %+v", r)
	}

	n := NewNPM(inner, NPMOptions{Instance: inst, NoCertificates: true})
	n.Configure(&NPMSettings{URL: npmURL, Email: "admin@panel.test", Password: "npm-test-password-1", ForwardHost: caddy, ForwardPort: 80, ForceSSL: true, FixedHosts: []string{"node1.test"}})
	route := Route{Host: "site.panel.test", Upstream: Upstream{Container: echo, Port: 8080}}
	if err := n.SetRoute(ctx, route); err != nil {
		t.Fatal(err)
	}
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	get := func(host, path string) (int, string) {
		req, _ := http.NewRequest("GET", "http://"+httpAddr+path, nil)
		req.Host = host
		resp, err := (&http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
		if err != nil {
			return 0, err.Error()
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	// NPM herlaadt nginx asynchroon na het aanmaken: even wachten.
	var code int
	var body string
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		if code, body = get("site.panel.test", "/hello"); code == 200 && strings.Contains(body, "npm-echo") {
			break
		}
	}
	if code != 200 || !strings.Contains(body, "npm-echo") {
		t.Fatalf("site via NPM → Caddy → container: %d %s", code, body)
	}
	// NPM zet X-Forwarded-For; Caddy (trusted_proxies private_ranges) geeft hem door.
	if !strings.Contains(strings.ToLower(body), "x-forwarded-for") {
		t.Fatalf("no X-Forwarded-For at the site: %s", body)
	}
	// Node-domein (vaste host) → Caddy → daemon-socket.
	if code, body = get("node1.test", "/"); code != 200 {
		t.Fatalf("node domain via NPM: %d %s", code, body)
	}

	cl, _ := newNPMClient(npmURL, "admin@panel.test", "npm-test-password-1", nil)
	hosts, err := cl.ProxyHosts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	mine := 0
	for _, ph := range hosts {
		if IsPanelManaged(ph.AdvancedConfig, inst) {
			mine++
			if !bool(ph.Websocket) || ph.ForwardHost != caddy || int(ph.ForwardPort) != 80 {
				t.Fatalf("proxy host %+v", ph)
			}
		}
	}
	if mine != 2 {
		t.Fatalf("own hosts in NPM: %d of %d", mine, len(hosts))
	}

	// Host van de gebruiker: conflict, nooit overschrijven of verwijderen.
	user, err := cl.CreateProxyHost(ctx, npmProxyHostBody{DomainNames: []string{"user.panel.test"}, ForwardScheme: "http", ForwardHost: echo, ForwardPort: 8080, Meta: map[string]any{}, Locations: []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.SetRoute(ctx, Route{Host: "user.panel.test", Upstream: Upstream{Container: echo, Port: 8080}}); err != nil {
		t.Fatal(err)
	}
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := n.Status(ctx, "user.panel.test"); st.SSL != SSLFailed || !strings.Contains(st.Error, "not managed by the panel") {
		t.Fatalf("conflict status %+v", st)
	}
	if err := n.Sync(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	hosts, _ = cl.ProxyHosts(ctx)
	var left []string
	for _, ph := range hosts {
		left = append(left, ph.DomainNames...)
		if int(ph.ID) == int(user.ID) && ph.AdvancedConfig != "" {
			t.Fatalf("user host changed: %+v", ph)
		}
	}
	if strings.Join(left, ",") != "node1.test,user.panel.test" && strings.Join(left, ",") != "user.panel.test,node1.test" {
		t.Fatalf("hosts after sync: %v", left)
	}
}
