package proxy

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"panel/daemon/proxy/npmtest"
)

func testNPM(t *testing.T, f *npmtest.Server, url string) (*NPM, *Fake) {
	fake := NewFake()
	n := NewNPM(fake, NPMOptions{Instance: "npm-test", DefaultForward: "172.17.0.1:8081", Now: f.Now})
	n.Configure(&NPMSettings{URL: url, Email: f.Email, Password: f.Password, ForceSSL: true, FixedHosts: []string{"node1.test"}})
	return n, fake
}

func npmSite(host string) Route {
	return Route{Host: host, ServerUUID: "11111111-2222-3333-4444-555555555555", Upstream: Upstream{Container: "panel-x", Port: 8080}}
}

func TestNPMCreatesHostsWithMarkerAndCertificates(t *testing.T) {
	f := npmtest.New(t)
	n, fake := testNPM(t, f, f.URL)
	ctx := context.Background()
	if err := n.SetRoute(ctx, npmSite("shop.panel.test")); err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Status(ctx, "shop.panel.test"); err != nil {
		t.Fatalf("route did not reach Caddy: %v", err)
	}
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"node1.test", "shop.panel.test"} {
		h := f.HostByDomain(d)
		if h == nil {
			t.Fatalf("no proxy host for %s", d)
		}
		if !IsPanelManaged(h["advanced_config"].(string), "npm-test") {
			t.Fatalf("%s: no marker in %q", d, h["advanced_config"])
		}
		if h["forward_host"] != "172.17.0.1" || h["forward_port"].(float64) != 8081 || h["forward_scheme"] != "http" {
			t.Fatalf("%s: forward %v:%v", d, h["forward_host"], h["forward_port"])
		}
		if h["allow_websocket_upgrade"] != true || h["ssl_forced"] != true || h["http2_support"] != true {
			t.Fatalf("%s: websocket/ssl/http2 not set: %v", d, h)
		}
		if h["certificate_id"].(float64) == 0 {
			t.Fatalf("%s: no certificate attached", d)
		}
		if !strings.Contains(h["advanced_config"].(string), " cert=") {
			t.Fatalf("%s: own certificate not recorded in the marker", d)
		}
	}
	st, err := n.Status(ctx, "shop.panel.test")
	if err != nil || st.SSL != SSLActive {
		t.Fatalf("status %+v %v", st, err)
	}
	if _, err := n.Status(ctx, "other.panel.test"); err != ErrNotFound {
		t.Fatalf("unknown host: %v", err)
	}
	ns := n.NPMStatus()
	if ns.State != NPMStateOK || ns.Version != "2.17.1" || ns.Managed != 2 || ns.ProxyHosts != 2 {
		t.Fatalf("npm status %+v", ns)
	}
	// Tweede ronde zonder wijzigingen: geen PUT's, geen nieuwe certificaten.
	puts, reqs := f.Puts, len(f.CertReqs)
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if f.Puts != puts || len(f.CertReqs) != reqs {
		t.Fatalf("idempotent round changed things: puts %d→%d, certs %d→%d", puts, f.Puts, reqs, len(f.CertReqs))
	}
	// Legacy-velden niet bij NPM ≥ 2.13.
	if _, ok := f.CertReqs[0]["meta"].(map[string]any)["letsencrypt_email"]; ok {
		t.Fatal("letsencrypt_email sent to NPM 2.17")
	}
}

func TestNPMConflictNeverOverwritesUserHost(t *testing.T) {
	f := npmtest.New(t)
	userID := f.UserHost("shop.panel.test")
	f.Redirect = []string{"redir.panel.test"}
	n, _ := testNPM(t, f, f.URL)
	ctx := context.Background()
	_ = n.Sync(ctx, []Route{npmSite("shop.panel.test"), npmSite("redir.panel.test"), npmSite("ok.panel.test")})
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	h := f.HostByDomain("shop.panel.test")
	if int(h["id"].(int)) != userID || h["forward_host"] != "10.0.0.5" || h["advanced_config"] != "# my own host" {
		t.Fatalf("user host changed: %v", h)
	}
	st, _ := n.Status(ctx, "shop.panel.test")
	if st.SSL != SSLFailed || !strings.Contains(st.Error, "not managed by the panel") {
		t.Fatalf("conflict status %+v", st)
	}
	st, _ = n.Status(ctx, "redir.panel.test")
	if st.SSL != SSLFailed || !strings.Contains(st.Error, "already used") {
		t.Fatalf("redirection conflict status %+v", st)
	}
	ns := n.NPMStatus()
	if len(ns.Conflicts) != 2 || ns.State != NPMStateOK {
		t.Fatalf("conflicts %+v", ns)
	}
	// Sync zonder de hosts: de host van de gebruiker blijft staan.
	_ = n.Sync(ctx, nil)
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if f.HostByDomain("shop.panel.test") == nil {
		t.Fatal("user host deleted")
	}
	if f.HostByDomain("ok.panel.test") != nil {
		t.Fatal("own host not deleted")
	}
	for _, d := range f.Deletes {
		if d == userID {
			t.Fatal("user host deleted")
		}
	}
}

func TestNPMRemovesOnlyOwnHostsAndOwnCertificates(t *testing.T) {
	f := npmtest.New(t)
	n, _ := testNPM(t, f, f.URL)
	ctx := context.Background()
	_ = n.SetRoute(ctx, npmSite("a.panel.test"))
	_ = n.Reconcile(ctx)
	// Een host van een andere panel-instance met de marker: niet van ons.
	f.Mu.Lock()
	other := f.NewID()
	f.Hosts[other] = map[string]any{"id": other, "domain_names": []any{"b.panel.test"}, "forward_scheme": "http", "forward_host": "x", "forward_port": float64(1),
		"certificate_id": float64(0), "advanced_config": MarkerPrefix + "main\n", "enabled": true, "meta": map[string]any{}}
	f.Mu.Unlock()
	h := f.HostByDomain("a.panel.test")
	certID := int(h["certificate_id"].(float64))
	if err := n.RemoveRoute(ctx, "a.panel.test"); err != nil {
		t.Fatal(err)
	}
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if f.HostByDomain("a.panel.test") != nil {
		t.Fatal("own host still there")
	}
	if _, ok := f.Certs[certID]; ok {
		t.Fatal("own certificate not deleted")
	}
	if f.HostByDomain("b.panel.test") == nil {
		t.Fatal("host of another instance deleted")
	}
	if f.HostByDomain("node1.test") == nil {
		t.Fatal("fixed host deleted")
	}
}

func TestNPMReusesExistingCertificateWithoutOwning(t *testing.T) {
	f := npmtest.New(t)
	f.Mu.Lock()
	cid := f.NewID()
	f.Certs[cid] = map[string]any{"id": cid, "provider": "letsencrypt", "nice_name": "*.panel.test", "domain_names": []any{"*.panel.test"},
		"expires_on": time.Now().Add(60 * 24 * time.Hour).UTC().Format(time.RFC3339), "meta": map[string]any{}}
	f.Mu.Unlock()
	n, _ := testNPM(t, f, f.URL)
	ctx := context.Background()
	_ = n.SetRoute(ctx, npmSite("c.panel.test"))
	_ = n.Reconcile(ctx)
	h := f.HostByDomain("c.panel.test")
	if int(h["certificate_id"].(float64)) != cid {
		t.Fatalf("existing wildcard certificate not reused: %v", h["certificate_id"])
	}
	if strings.Contains(h["advanced_config"].(string), " cert=") {
		t.Fatal("reused certificate marked as own")
	}
	_ = n.RemoveRoute(ctx, "c.panel.test")
	_ = n.Reconcile(ctx)
	if _, ok := f.Certs[cid]; !ok {
		t.Fatal("certificate of the user deleted")
	}
}

func TestNPMTokenRenewal(t *testing.T) {
	f := npmtest.New(t)
	now := time.Now()
	var mu sync.Mutex
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	f.Now = clock
	f.TTL = time.Hour
	n, _ := testNPM(t, f, f.URL)
	ctx := context.Background()
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if f.Logins != 1 {
		t.Fatalf("logins %d", f.Logins)
	}
	_ = n.Reconcile(ctx)
	if f.Logins != 1 {
		t.Fatalf("token not reused: %d logins", f.Logins)
	}
	// Bijna verlopen: vooraf vernieuwen.
	mu.Lock()
	now = now.Add(55 * time.Minute)
	mu.Unlock()
	_ = n.Reconcile(ctx)
	if f.Logins != 2 {
		t.Fatalf("token not renewed before expiry: %d logins", f.Logins)
	}
	// NPM trekt het token in (herstart, andere secret): 401 → opnieuw inloggen.
	f.Mu.Lock()
	f.Tokens = map[string]time.Time{}
	f.Mu.Unlock()
	if err := n.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if f.Logins != 3 {
		t.Fatalf("no re-login after 401: %d logins", f.Logins)
	}
}

func TestNPMLoginFailedAndUnreachable(t *testing.T) {
	f := npmtest.New(t)
	n := NewNPM(NewFake(), NPMOptions{Instance: "npm-test"})
	n.Configure(&NPMSettings{URL: f.URL, Email: f.Email, Password: "wrong", FixedHosts: []string{"node1.test"}})
	if err := n.Reconcile(context.Background()); err == nil {
		t.Fatal("no error")
	}
	if st := n.NPMStatus(); st.State != NPMStateLoginFailed || strings.Contains(st.Error, "wrong") {
		t.Fatalf("status %+v", st)
	}
	f.TwoFA = true
	n.Configure(&NPMSettings{URL: f.URL, Email: f.Email, Password: f.Password})
	_ = n.Reconcile(context.Background())
	if st := n.NPMStatus(); st.State != NPMStateLoginFailed || !strings.Contains(st.Error, "two-factor") {
		t.Fatalf("2fa status %+v", st)
	}
	n.Configure(&NPMSettings{URL: "http://127.0.0.1:1", Email: "a@panel.test", Password: "x"})
	_ = n.Reconcile(context.Background())
	if st := n.NPMStatus(); st.State != NPMStateUnreachable {
		t.Fatalf("unreachable status %+v", st)
	}
	n.Configure(nil)
	_ = n.Reconcile(context.Background())
	if st := n.NPMStatus(); st.State != NPMStateUnconfigured {
		t.Fatalf("unconfigured status %+v", st)
	}
}

func TestNPMCertificateFailureBackoffAndDNS(t *testing.T) {
	f := npmtest.New(t)
	now := time.Now()
	var mu sync.Mutex
	f.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	f.CertFail["bad.panel.test"] = "Some challenges have failed. DNS problem: NXDOMAIN looking up A for bad.panel.test"
	n := NewNPM(NewFake(), NPMOptions{Instance: "npm-test", Now: f.Now, CertRetry: time.Hour})
	n.Configure(&NPMSettings{URL: f.URL, Email: f.Email, Password: f.Password, SSL: NPMSSLHTTP})
	ctx := context.Background()
	_ = n.SetRoute(ctx, npmSite("bad.panel.test"))
	wild := npmSite("*.wild.panel.test")
	wild.Wildcard = true
	_ = n.SetRoute(ctx, wild)
	_ = n.Reconcile(ctx)
	st, _ := n.Status(ctx, "bad.panel.test")
	if st.SSL != SSLDNSWrong || !strings.Contains(st.Error, "NXDOMAIN") {
		t.Fatalf("status %+v", st)
	}
	st, _ = n.Status(ctx, "*.wild.panel.test")
	if st.SSL != SSLFailed || !strings.Contains(st.Error, "DNS challenge") {
		t.Fatalf("wildcard status %+v", st)
	}
	reqs := len(f.CertReqs)
	_ = n.Reconcile(ctx)
	if len(f.CertReqs) != reqs {
		t.Fatal("certificate retried without backoff")
	}
	mu.Lock()
	now = now.Add(61 * time.Minute)
	mu.Unlock()
	_ = n.Reconcile(ctx)
	if len(f.CertReqs) != reqs+1 {
		t.Fatalf("certificate not retried after backoff: %d → %d", reqs, len(f.CertReqs))
	}
	// Wildcard met een DNS-challenge van de route: DNS-01 via Cloudflare.
	wild.DNSChallenge = &DNSChallenge{Provider: "cloudflare", APIToken: "cf-token-123"}
	_ = n.SetRoute(ctx, wild)
	_ = n.Reconcile(ctx)
	last := f.CertReqs[len(f.CertReqs)-1]
	meta := last["meta"].(map[string]any)
	if meta["dns_challenge"] != true || meta["dns_provider"] != "cloudflare" || meta["dns_provider_credentials"] != "dns_cloudflare_api_token = cf-token-123" {
		t.Fatalf("dns challenge request %v", last)
	}
	if st, _ := n.Status(ctx, "*.wild.panel.test"); st.SSL != SSLActive {
		t.Fatalf("wildcard after dns challenge: %+v", st)
	}
}

func TestNPMLegacyVersionSendsLetsEncryptEmail(t *testing.T) {
	f := npmtest.New(t)
	f.Version = [3]int{2, 12, 6}
	n := NewNPM(NewFake(), NPMOptions{Instance: "npm-test"})
	n.Configure(&NPMSettings{URL: f.URL, Email: f.Email, Password: f.Password, LetsEncryptEmail: "le@panel.test", FixedHosts: []string{"node1.test"}})
	_ = n.Reconcile(context.Background())
	if len(f.CertReqs) != 1 {
		t.Fatalf("cert requests %d", len(f.CertReqs))
	}
	meta := f.CertReqs[0]["meta"].(map[string]any)
	if meta["letsencrypt_email"] != "le@panel.test" || meta["letsencrypt_agree"] != true {
		t.Fatalf("legacy meta %v", meta)
	}
}

func TestNPMCaddyGetsNoDNSChallenge(t *testing.T) {
	var got []Route
	inner := &recRouter{set: func(r Route) { got = append(got, r) }}
	n := NewNPM(inner, NPMOptions{})
	r := npmSite("*.x.panel.test")
	r.Wildcard = true
	r.DNSChallenge = &DNSChallenge{Provider: "cloudflare", APIToken: "tok"}
	if err := n.SetRoute(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].DNSChallenge != nil {
		t.Fatalf("caddy got %+v", got)
	}
	st, err := n.Status(context.Background(), "*.x.panel.test")
	if err != nil || st.SSL != SSLPending || !strings.Contains(st.Error, "not configured") {
		t.Fatalf("status without settings %+v %v", st, err)
	}
}

func TestTestNPM(t *testing.T) {
	f := npmtest.New(t)
	f.UserHost("x.panel.test")
	r := TestNPM(context.Background(), NPMSettings{URL: f.URL, Email: f.Email, Password: f.Password}, "npm-test", nil)
	if r.State != NPMStateOK || r.ProxyHosts != 1 || r.Managed != 0 || r.Version != "2.17.1" {
		t.Fatalf("%+v", r)
	}
	r = TestNPM(context.Background(), NPMSettings{URL: f.URL, Email: f.Email, Password: "nope"}, "npm-test", nil)
	if r.State != NPMStateLoginFailed {
		t.Fatalf("%+v", r)
	}
	r = TestNPM(context.Background(), NPMSettings{URL: "ftp://x", Email: f.Email, Password: "nope"}, "npm-test", nil)
	if r.State != NPMStateError {
		t.Fatalf("%+v", r)
	}
}

type recRouter struct{ set func(Route) }

func (r *recRouter) SetRoute(_ context.Context, rt Route) error { r.set(rt); return nil }
func (r *recRouter) RemoveRoute(context.Context, string) error  { return nil }
func (r *recRouter) Sync(context.Context, []Route) error        { return nil }
func (r *recRouter) Status(context.Context, string) (RouteStatus, error) {
	return RouteStatus{}, fmt.Errorf("not used")
}
