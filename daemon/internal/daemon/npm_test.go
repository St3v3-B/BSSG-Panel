package daemon

import (
	"strings"
	"testing"
	"time"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/testpanel"
	"panel/daemon/proxy"
	"panel/daemon/proxy/npmtest"
)

// HTTP_MODE=npm: de daemon haalt de NPM-instellingen bij het panel, zet de proxy hosts (node-domein + routes)
// in NPM, leest de SSL-status uit NPM en meldt de toestand aan het panel.
func TestNPMModeEndToEnd(t *testing.T) {
	f := npmtest.New(t)
	p := testpanel.New(nodeToken, "node1.test")
	t.Cleanup(p.Close)
	p.SetNPM(map[string]any{"enabled": true, "url": f.URL, "email": f.Email, "password": f.Password, "ssl": "http", "force_ssl": true, "fixed_hosts": []string{"node1.test"}})
	fake := proxy.NewFake()
	h := newHarnessWith(t, engine.NewFake(), fake, p, "", nil, "", func(c *config.Config, d *Deps) {
		c.HTTPMode, c.NPMCaddyAddr = "npm", "172.17.0.1:18081"
		d.NPMInterval = 50 * time.Millisecond
		d.NPMOptions = proxy.NPMOptions{Interval: 50 * time.Millisecond}
	})
	if h.d.NPMRouter() == nil {
		t.Fatal("no NPM router in npm mode")
	}
	web := testSpec(u1)
	web["type"] = "web"
	web["allocations"] = []any{}
	web["http_port"] = 8080
	h.expect("POST", "/api/servers", web, 202)
	h.expect("PUT", "/api/routes/site.panel.test", map[string]any{"server_uuid": u1}, 200)
	if _, err := fake.Status(t.Context(), "site.panel.test"); err != nil {
		t.Fatal("route not in Caddy:", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for f.HostByDomain("site.panel.test") == nil || f.HostByDomain("node1.test") == nil {
		if time.Now().After(deadline) {
			t.Fatal("proxy hosts not created in NPM")
		}
		time.Sleep(20 * time.Millisecond)
	}
	ph := f.HostByDomain("site.panel.test")
	if ph["forward_host"] != "172.17.0.1" || ph["forward_port"].(float64) != 18081 {
		t.Fatalf("forward %v:%v", ph["forward_host"], ph["forward_port"])
	}
	var rs map[string]any
	for time.Now().Before(deadline) {
		h.expect("GET", "/api/routes/site.panel.test", nil, 200).json(t, &rs)
		if rs["ssl_status"] == "active" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if rs["ssl_status"] != "active" {
		t.Fatalf("ssl status from NPM: %v", rs)
	}
	var st map[string]any
	h.expect("GET", "/api/npm", nil, 200).json(t, &st)
	if st["http_mode"] != "npm" || st["state"] != "ok" || st["configured"] != true || st["managed_hosts"].(float64) != 2 {
		t.Fatalf("npm state %v", st)
	}
	if strings.Contains(string(h.expect("GET", "/api/npm", nil, 200).Body), f.Password) {
		t.Fatal("password in /api/npm")
	}
	for time.Now().Before(deadline) && len(p.Calls("/api/remote/npm/status")) == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if len(p.Calls("/api/remote/npm/status")) == 0 {
		t.Fatal("no status report to the panel")
	}
	// Test verbinding: verkeerd wachtwoord → login_failed; zonder velden → 400.
	var tr map[string]any
	h.expect("POST", "/api/npm/test", map[string]any{"url": f.URL, "email": f.Email, "password": "wrong"}, 200).json(t, &tr)
	if tr["state"] != "login_failed" {
		t.Fatal(tr)
	}
	h.expect("POST", "/api/npm/test", map[string]any{"url": f.URL}, 400)
	// Route weg → proxy host weg; panel zet NPM uit → hosts blijven staan (niets automatisch verwijderen).
	h.expect("DELETE", "/api/routes/site.panel.test", nil, 204)
	for f.HostByDomain("site.panel.test") != nil {
		if time.Now().After(deadline) {
			t.Fatal("proxy host not removed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	p.SetNPM(map[string]any{"enabled": false})
	h.expect("POST", "/api/npm/refresh", nil, 204)
	h.expect("GET", "/api/npm", nil, 200).json(t, &st)
	if st["configured"] != false {
		t.Fatal(st)
	}
	if f.HostByDomain("node1.test") == nil {
		t.Fatal("node host removed after disabling")
	}
}

// Buiten npm-modus: geen NPM-router, direct blijft zoals het was.
func TestDirectModeHasNoNPM(t *testing.T) {
	h := newHarness(t, engine.NewFake(), nil, nil, "", nil, "")
	if h.d.NPMRouter() != nil {
		t.Fatal("NPM router in direct mode")
	}
	if _, ok := h.d.deps.Router.(*proxy.NPM); ok {
		t.Fatal("router wrapped")
	}
	var st map[string]any
	h.expect("GET", "/api/npm", nil, 200).json(t, &st)
	if st["http_mode"] != "" && st["http_mode"] != "direct" || st["state"] != "unconfigured" {
		t.Fatal(st)
	}
}
