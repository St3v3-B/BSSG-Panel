package proxy

// TLS-automation-policies voor routes met een DNS-challenge (wildcards).
//
// Per route met DNSChallenge staat er in apps/tls/automation/policies een policy met
// @id panel-tls-<host> en subjects [*.example.nl, example.nl] (of alleen de host).
// De issuers worden overgenomen van de policy uit de basisconfig (e-mail, CA zoals
// LE-staging), met challenges.dns.provider erbij. Onze policies staan vóór die van de
// basisconfig: Caddy neemt de eerste policy die past (en een policy zonder subjects
// past op alles). Andere policies worden nooit gewijzigd.
//
// Het token staat alleen in de Caddy-config; foutmeldingen worden ervan ontdaan.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

// PolicyIDPrefix markeert de TLS-policies die de router beheert.
const PolicyIDPrefix = "panel-tls-"

const policiesPath = "/config/apps/tls/automation/policies"

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{30,64}$`) // Cloudflare-API-token (40 tekens)

func policyID(host string) string { return PolicyIDPrefix + strings.ReplaceAll(host, "*", "_") }

// policySubjects: *.example.nl → [*.example.nl, example.nl]; anders [host].
func policySubjects(host string) []string {
	if strings.HasPrefix(host, "*.") {
		return []string{host, host[2:]}
	}
	return []string{host}
}

// baseIssuers: de ACME-issuers van de eerste policy uit de basisconfig (zonder
// challenges), of één kale ACME-issuer.
func baseIssuers(fixed []any) []map[string]any {
	for _, p := range fixed {
		pm, _ := p.(map[string]any)
		iss, _ := pm["issuers"].([]any)
		var out []map[string]any
		for _, i := range iss {
			im, _ := i.(map[string]any)
			if im["module"] != "acme" {
				continue
			}
			n := map[string]any{"module": "acme"}
			for _, k := range []string{"ca", "email", "test_ca", "trusted_roots_pem_files", "preferred_chains"} {
				if v, ok := im[k]; ok {
					n[k] = v
				}
			}
			out = append(out, n)
		}
		if len(out) > 0 {
			return out
		}
	}
	return []map[string]any{{"module": "acme"}}
}

func buildPolicy(host string, subjects []string, ch DNSChallenge, base []map[string]any) any {
	iss := make([]any, 0, len(base))
	for _, b := range base {
		n := map[string]any{}
		for k, v := range b {
			n[k] = v
		}
		n["challenges"] = map[string]any{"dns": map[string]any{
			"provider": map[string]any{"name": ch.Provider, "api_token": ch.APIToken},
		}}
		iss = append(iss, n)
	}
	p, _ := canon(map[string]any{"@id": policyID(host), "subjects": subjects, "issuers": iss})
	return p
}

// tokenFromPolicy haalt de provider en het token uit een bestaande policy van ons.
func tokenFromPolicy(p any) (DNSChallenge, bool) {
	pm, _ := p.(map[string]any)
	iss, _ := pm["issuers"].([]any)
	for _, i := range iss {
		im, _ := i.(map[string]any)
		ch, _ := im["challenges"].(map[string]any)
		dns, _ := ch["dns"].(map[string]any)
		prov, _ := dns["provider"].(map[string]any)
		name, _ := prov["name"].(string)
		tok, _ := prov["api_token"].(string)
		if name != "" && tok != "" {
			return DNSChallenge{Provider: name, APIToken: tok}, true
		}
	}
	return DNSChallenge{}, false
}

func (c *Caddy) getPolicies(ctx context.Context) ([]any, bool, string, error) {
	resp, b, err := c.do(ctx, http.MethodGet, policiesPath, nil, nil)
	if err != nil {
		return nil, false, "", err
	}
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusBadRequest {
		return nil, false, "", nil // pad bestaat (nog) niet
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, "", fmt.Errorf("proxy: Caddy GET %s: %s", policiesPath, resp.Status)
	}
	var ps []any
	if err := json.Unmarshal(b, &ps); err != nil {
		return nil, false, "", fmt.Errorf("proxy: Caddy-policies onleesbaar")
	}
	return ps, ps != nil, resp.Header.Get("Etag"), nil
}

// syncPolicies maakt onze policies gelijk aan de routes in dyn met een DNS-challenge.
// Het token komt van de binnenkomende route (dynRoute.chal) of uit de bestaande policy.
func (c *Caddy) syncPolicies(ctx context.Context, dyn map[string]dynRoute) error {
	var want []dynRoute
	for _, d := range dyn {
		if d.dns != "" {
			want = append(want, d)
		}
	}
	for attempt := 1; ; attempt++ {
		cur, exists, etag, err := c.getPolicies(ctx)
		if err != nil {
			return err
		}
		var fixed []any
		ours := map[string]any{}
		for _, p := range cur {
			pm, _ := p.(map[string]any)
			if id, _ := pm["@id"].(string); strings.HasPrefix(id, PolicyIDPrefix) {
				ours[id] = p
				continue
			}
			fixed = append(fixed, p)
		}
		if len(want) == 0 && len(ours) == 0 {
			return nil
		}
		// Exacte hosts vóór wildcards; elk subject maar in één policy.
		sort.Slice(want, func(i, j int) bool {
			wi, wj := strings.HasPrefix(want[i].host, "*."), strings.HasPrefix(want[j].host, "*.")
			if wi != wj {
				return !wi
			}
			return want[i].host < want[j].host
		})
		base := baseIssuers(fixed)
		used := map[string]bool{}
		var next []any
		var errs []error
		var secrets []string
		for _, d := range want {
			var ch DNSChallenge
			switch {
			case d.chal != nil:
				ch = *d.chal
			default:
				var ok bool
				if ch, ok = tokenFromPolicy(ours[policyID(d.host)]); !ok {
					errs = append(errs, fmt.Errorf("proxy: %s: DNS-challenge zonder token in Caddy (Sync nodig)", d.host))
					continue
				}
			}
			secrets = append(secrets, ch.APIToken)
			var subj []string
			for _, s := range policySubjects(d.host) {
				if !used[s] {
					used[s] = true
					subj = append(subj, s)
				}
			}
			if len(subj) > 0 {
				next = append(next, buildPolicy(d.host, subj, ch, base))
			}
		}
		next = append(next, fixed...)
		if reflect.DeepEqual(cur, next) || (len(next) == 0 && !exists) {
			return errors.Join(errs...)
		}
		err = c.writePolicies(ctx, next, exists, etag)
		if errors.Is(err, errConflict) && attempt < maxAttempts {
			continue
		}
		if err != nil {
			err = errors.New(redact(err.Error(), secrets))
		}
		return errors.Join(append(errs, err)...)
	}
}

// writePolicies schrijft de lijst; bestaat apps/tls(/automation) nog niet, dan wordt
// die aangemaakt.
func (c *Caddy) writePolicies(ctx context.Context, ps []any, exists bool, etag string) error {
	if exists {
		hdr := map[string]string{}
		if etag != "" {
			hdr["If-Match"] = etag
		}
		return c.expectOK(c.do(ctx, http.MethodPatch, policiesPath, ps, hdr))
	}
	auto := map[string]any{"policies": ps}
	resp, b, err := c.do(ctx, http.MethodGet, "/config/apps/tls", nil, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusOK && strings.TrimSpace(string(b)) != "null" {
		return c.expectOK(c.do(ctx, http.MethodPut, "/config/apps/tls/automation", auto, nil))
	}
	return c.expectOK(c.do(ctx, http.MethodPut, "/config/apps/tls", map[string]any{"automation": auto}, nil))
}

func (c *Caddy) expectOK(resp *http.Response, b []byte, err error) error {
	if err != nil {
		return err
	}
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusPreconditionFailed:
		return errConflict
	}
	return fmt.Errorf("proxy: Caddy weigert de TLS-policies: %s: %s", resp.Status, strings.TrimSpace(string(b)))
}

// redact haalt geheimen uit een tekst (voor logs en foutmeldingen).
func redact(s string, secrets []string) string {
	for _, t := range secrets {
		if t != "" {
			s = strings.ReplaceAll(s, t, "[verborgen]")
		}
	}
	return s
}
