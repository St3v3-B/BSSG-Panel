package proxy

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// Regels zoals Caddy ze logt (JSON, zonder TTY).
const caddyLog = `{"level":"info","ts":1,"logger":"tls.obtain","msg":"acquiring lock","identifier":"a.example.nl"}
{"level":"error","ts":2,"logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"a.example.nl","issuer":"acme-v02.api.letsencrypt.org-directory","error":"HTTP 400 urn:ietf:params:acme:error:connection - 203.0.113.9: Timeout during connect (likely firewall problem)"}
{"level":"error","ts":3,"logger":"tls.obtain","msg":"will retry","error":"[b.example.nl] Obtain: [b.example.nl] solving challenges: presenting for challenge: rate limited, api_token=abc123 (order=https://acme/1)","attempt":1}
{"level":"error","ts":4,"logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"c.example.nl","error":"HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up A for c.example.nl"}
{"level":"info","ts":5,"logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"c.example.nl"}
{"level":"error","ts":6,"logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"*.w.example.nl","error":"HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up TXT for _acme-challenge.w.example.nl"}
`

func TestLastObtainResult(t *testing.T) {
	for _, tc := range []struct {
		host string
		st   SSLStatus
		ok   bool
		in   string
	}{
		{"a.example.nl", SSLDNSWrong, true, "Timeout during connect"},
		{"b.example.nl", SSLFailed, true, "rate limited"},
		{"c.example.nl", "", false, ""}, // daarna gelukt
		{"*.w.example.nl", SSLFailed, true, "_acme-challenge"},
		{"d.example.nl", "", false, ""},
	} {
		st, msg, ok := lastObtainResult([]byte(caddyLog), tc.host)
		if ok != tc.ok || (ok && (st != tc.st || !strings.Contains(msg, tc.in))) {
			t.Errorf("%s: %s %q %v", tc.host, st, msg, ok)
		}
		if strings.Contains(msg, "abc123") {
			t.Errorf("%s: geheim in melding: %s", tc.host, msg)
		}
	}
}

func TestDNSMismatch(t *testing.T) {
	c := &Caddy{res: fakeResolver{"goed.test": {"192.0.2.10"}, "fout.test": {"198.51.100.1"}}, nodeIPs: []net.IP{net.ParseIP("192.0.2.10")}}
	ctx := context.Background()
	if msg, wrong := c.dnsMismatch(ctx, "goed.test"); wrong {
		t.Error(msg)
	}
	if msg, wrong := c.dnsMismatch(ctx, "fout.test"); !wrong || !strings.Contains(msg, "198.51.100.1") || !strings.Contains(msg, "192.0.2.10") {
		t.Errorf("%v %q", wrong, msg)
	}
	if msg, wrong := c.dnsMismatch(ctx, "weg.test"); !wrong || !strings.Contains(msg, "no A or AAAA record") {
		t.Errorf("%v %q", wrong, msg)
	}
}

func TestStatusDiagnose(t *testing.T) {
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{
		Resolver: fakeResolver{"a.example.nl": {"192.0.2.10"}, "c.example.nl": {"192.0.2.10"}, "elders.example.nl": {"198.51.100.7"}},
		NodeIPs:  []net.IP{net.ParseIP("192.0.2.10")},
		Logs:     func(context.Context, time.Time) ([]byte, error) { return []byte(caddyLog), nil },
	})
	ctx := context.Background()
	if st, msg := c.diagnose(ctx, "a.example.nl", "x"); st != SSLDNSWrong || !strings.Contains(msg, "Timeout") {
		t.Errorf("a: %s %q", st, msg)
	}
	if st, msg := c.diagnose(ctx, "elders.example.nl", "x"); st != SSLDNSWrong || !strings.Contains(msg, "198.51.100.7") {
		t.Errorf("elders: %s %q", st, msg)
	}
	if st, msg := c.diagnose(ctx, "c.example.nl", "nog geen certificaat"); st != SSLIssuing || msg != "nog geen certificaat" {
		t.Errorf("c: %s %q", st, msg)
	}
}

func TestDemuxLogs(t *testing.T) {
	frame := func(s string) []byte {
		n := len(s)
		return append([]byte{2, 0, 0, 0, byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}, s...)
	}
	b := append(frame("regel 1\n"), frame("regel 2\n")...)
	if got := string(demuxLogs(b)); got != "regel 1\nregel 2\n" {
		t.Errorf("%q", got)
	}
	if got := string(demuxLogs([]byte("{\"a\":1}\n"))); got != "{\"a\":1}\n" {
		t.Errorf("tty: %q", got)
	}
}
