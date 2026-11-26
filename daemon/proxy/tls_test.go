package proxy

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const cfToken = "CfGeheimToken0123456789abcdefghijklmnopq"

func TestDNSChallengePolicies(t *testing.T) {
	f := newFakeAdmin(t)
	f.tlsApp = true
	_ = json.Unmarshal([]byte(`[{"subjects":["panel.test","node1.test"],"issuers":[{"module":"acme","email":"a@panel.test","ca":"https://acme-staging-v02.api.letsencrypt.org/directory"},{"module":"acme","email":"a@panel.test","ca":"https://acme.zerossl.com/v2/DV90"}]}]`), &f.policies)
	c := newTestCaddy(t, f, CaddyOptions{})
	ctx := context.Background()
	dns := &DNSChallenge{Provider: "cloudflare", APIToken: cfToken}

	if err := c.SetRoute(ctx, Route{Host: "*.Voorbeeld.test", Wildcard: true, DNSChallenge: dns, Upstream: Upstream{Container: "w", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	if err := c.SetRoute(ctx, Route{Host: "a.test", Upstream: Upstream{Container: "a", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	if len(f.policies) != 2 {
		t.Fatalf("policies = %s", mustJSON(f.policies))
	}
	p := mustJSON(f.policies[0])
	for _, want := range []string{`"@id":"panel-tls-_.voorbeeld.test"`, `"subjects":["*.voorbeeld.test","voorbeeld.test"]`,
		`"provider":{"api_token":"` + cfToken + `","name":"cloudflare"}`, `"ca":"https://acme-staging-v02.api.letsencrypt.org/directory"`, `"email":"a@panel.test"`} {
		if !strings.Contains(p, want) {
			t.Errorf("policy mist %s: %s", want, p)
		}
	}
	if mustJSON(f.policies[1]) != `{"issuers":[{"ca":"https://acme-staging-v02.api.letsencrypt.org/directory","email":"a@panel.test","module":"acme"},{"ca":"https://acme.zerossl.com/v2/DV90","email":"a@panel.test","module":"acme"}],"subjects":["panel.test","node1.test"]}` {
		t.Errorf("basispolicy gewijzigd: %s", mustJSON(f.policies[1]))
	}
	// Het token staat niet in de route zelf, wel de provider.
	if r := mustJSON(f.find("panel-dyn-_.voorbeeld.test")); strings.Contains(r, cfToken) || !strings.Contains(r, `"panel_dns":"cloudflare"`) {
		t.Errorf("route: %s", r)
	}

	// Sync zonder token (bv. na een daemon-herstart met dezelfde routes) houdt de policy.
	before := mustJSON(f.policies)
	if err := c.Sync(ctx, []Route{{Host: "*.voorbeeld.test", DNSChallenge: dns, Upstream: Upstream{Container: "w", Port: 80}}}); err != nil {
		t.Fatal(err)
	}
	if mustJSON(f.policies) != before {
		t.Errorf("policy veranderd door gelijke Sync")
	}
	// Een andere route (zonder DNS) wijzigen laat de policy staan, ook zonder token.
	if err := c.SetRoute(ctx, Route{Host: "b.test", Upstream: Upstream{Container: "b", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	if mustJSON(f.policies) != before {
		t.Errorf("policy veranderd door SetRoute van een andere host")
	}
	// Nieuw token → policy bijgewerkt.
	if err := c.SetRoute(ctx, Route{Host: "*.voorbeeld.test", DNSChallenge: &DNSChallenge{Provider: "cloudflare", APIToken: "NieuwToken0123456789abcdefghijklmnopqrst"}, Upstream: Upstream{Container: "w", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(mustJSON(f.policies[0]), "NieuwToken0123456789abcdefghijklmnopqrst") {
		t.Errorf("token niet bijgewerkt")
	}
	// RemoveRoute ruimt de policy op; basispolicy blijft.
	if err := c.RemoveRoute(ctx, "*.voorbeeld.test"); err != nil {
		t.Fatal(err)
	}
	if len(f.policies) != 1 || strings.Contains(mustJSON(f.policies), "panel-tls-") {
		t.Errorf("policy niet opgeruimd: %s", mustJSON(f.policies))
	}
	// Sync ruimt ook op.
	_ = c.SetRoute(ctx, Route{Host: "*.x.test", DNSChallenge: dns, RedirectTo: "x.test"})
	if len(f.policies) != 2 {
		t.Fatalf("redirect-wildcard zonder policy: %s", mustJSON(f.policies))
	}
	if err := c.Sync(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if len(f.policies) != 1 {
		t.Errorf("Sync ruimt policy niet op: %s", mustJSON(f.policies))
	}
}

func TestDNSChallengeWithoutTLSApp(t *testing.T) {
	f := newFakeAdmin(t) // geen apps/tls
	c := newTestCaddy(t, f, CaddyOptions{})
	ctx := context.Background()
	if err := c.SetRoute(ctx, Route{Host: "*.v.test", DNSChallenge: &DNSChallenge{Provider: "cloudflare", APIToken: cfToken}, Upstream: Upstream{Container: "w", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	if len(f.policies) != 1 || !strings.Contains(mustJSON(f.policies[0]), `"issuers":[{"challenges":{"dns":{"provider":{"api_token":"`+cfToken+`","name":"cloudflare"}}},"module":"acme"}]`) {
		t.Fatalf("policies = %s", mustJSON(f.policies))
	}
	// Exacte host en wildcard delen geen subject.
	if err := c.SetRoute(ctx, Route{Host: "v.test", DNSChallenge: &DNSChallenge{Provider: "cloudflare", APIToken: cfToken}, Upstream: Upstream{Container: "w", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	all := mustJSON(f.policies)
	if strings.Count(all, `"v.test"`) != 1 {
		t.Errorf("subject dubbel: %s", all)
	}
}

func TestDNSChallengeValidationAndRedaction(t *testing.T) {
	for _, d := range []*DNSChallenge{{Provider: "route53", APIToken: cfToken}, {Provider: "cloudflare"}, {Provider: "cloudflare", APIToken: "met spatie erin"}} {
		if _, err := normRoute(Route{Host: "*.a.test", DNSChallenge: d, Upstream: Upstream{Container: "c", Port: 80}}); err == nil {
			t.Errorf("%+v geaccepteerd", d)
		} else if d.APIToken != "" && strings.Contains(err.Error(), d.APIToken) {
			t.Errorf("token in fout: %v", err)
		}
	}
	if got := redact("fout met "+cfToken+" erin", []string{cfToken}); strings.Contains(got, cfToken) {
		t.Error(got)
	}
}
