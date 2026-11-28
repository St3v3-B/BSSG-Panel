package relay

import (
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

const secret = "s3cret-relay-secret"

type env struct {
	t      *testing.T
	edge   *Edge
	tunnel *httptest.Server // TLS: /api/relay/tunnel van A
	front  *httptest.Server // de relay-socket van A (wat Caddy aanroept)
	web    *httptest.Server // Caddy van B
	client *Client
	roots  *x509.CertPool
}

func clients(hosts ...string) []ClientConfig {
	var hs []Host
	for _, h := range hosts {
		hs = append(hs, Host{Host: h})
	}
	return []ClientConfig{{NodeID: 2, Fqdn: "node2.test", Secret: secret, Hosts: hs}}
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, edge: &Edge{Self: "node1.test", Dial: "unix//run/panel/relay.sock", PingInterval: 50 * time.Millisecond}}
	e.edge.SetClients(clients("site.example.test", "*.wild.test"))
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+TunnelPath, e.edge.TunnelHandler)
	e.tunnel = httptest.NewTLSServer(mux)
	e.front = httptest.NewServer(e.edge)
	e.web = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "web %s %s xff=%s", r.Host, r.URL.Path, r.Header.Get("X-Forwarded-For"))
	}))
	e.roots = x509.NewCertPool()
	e.roots.AddCert(e.tunnel.Certificate())
	t.Cleanup(func() {
		if e.client != nil {
			e.client.Close()
		}
		e.edge.Close()
		e.tunnel.Close()
		e.front.Close()
		e.web.Close()
	})
	return e
}

func apiHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/system", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "api of node2 "+r.Host)
	})
	up := websocket.Upgrader{}
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			t, m, err := c.ReadMessage()
			if err != nil {
				return
			}
			_ = c.WriteMessage(t, append([]byte("echo:"), m...))
		}
	})
	return mux
}

func (e *env) start(sec string) *Client {
	e.t.Helper()
	c := &Client{Self: "node2.test", API: apiHandler(), Web: e.web.URL, RootCAs: e.roots,
		MinBackoff: 20 * time.Millisecond, MaxBackoff: 100 * time.Millisecond, PingInterval: 50 * time.Millisecond}
	c.Set(&EdgeConfig{NodeID: 1, URL: e.tunnel.URL, Fqdn: "node1.test", ClientID: 2, Secret: sec})
	e.client = c
	return c
}

func waitFor(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout: %s", what)
}

func (e *env) get(host, path string) (int, string) {
	e.t.Helper()
	req, _ := http.NewRequest("GET", e.front.URL+path, nil)
	req.Host = host
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestRelayRoundTrip(t *testing.T) {
	e := newEnv(t)
	c := e.start(secret)
	waitFor(t, "verbonden", func() bool { return c.Status().Connected })
	waitFor(t, "edge ziet client", func() bool { s := e.edge.Status(); return len(s) == 1 && s[0].Connected && s[0].LatencyMs != nil })
	waitFor(t, "latency bij B", func() bool { return c.Status().LatencyMs != nil })

	if code, body := e.get("site.example.test", "/x"); code != 200 || !strings.HasPrefix(body, "web site.example.test /x") || !strings.Contains(body, "203.0.113.9") {
		t.Fatal(code, body)
	}
	if code, body := e.get("node2.test", "/api/system"); code != 200 || body != "api of node2 node2.test" {
		t.Fatal(code, body)
	}
	if code, body := e.get("a.wild.test", "/"); code != 200 || !strings.HasPrefix(body, "web a.wild.test") {
		t.Fatal(code, body)
	}
	// Onbekende hostnamen (ook twee labels onder de wildcard en het eigen domein van A) stuurt A niet door.
	for _, h := range []string{"evil.test", "b.a.wild.test", "wild.test", "node1.test", "panel.test"} {
		if code, body := e.get(h, "/"); code != http.StatusMisdirectedRequest || !strings.Contains(body, "unknown_host") {
			t.Fatal(h, code, body)
		}
	}
	// Websocket door de tunnel naar de API van B.
	ws, _, err := websocket.DefaultDialer.Dial(strings.Replace(e.front.URL, "http://", "ws://", 1)+"/ws", http.Header{"Host": {"node2.test"}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	for i := 0; i < 3; i++ {
		if err := ws.WriteMessage(websocket.TextMessage, []byte("hi"+strconv.Itoa(i))); err != nil {
			t.Fatal(err)
		}
		_, m, err := ws.ReadMessage()
		if err != nil || string(m) != "echo:hi"+strconv.Itoa(i) {
			t.Fatal(string(m), err)
		}
	}
}

func TestRelayReconnect(t *testing.T) {
	e := newEnv(t)
	c := e.start(secret)
	waitFor(t, "verbonden", func() bool { return c.Status().Connected })
	e.edge.DropAll()
	waitFor(t, "weer verbonden", func() bool { s := c.Status(); return s.Connected && s.Reconnects >= 1 })
	if code, body := e.get("site.example.test", "/"); code != 200 {
		t.Fatal(code, body)
	}
	// B is weg: A antwoordt 502 relay_offline (Caddy toont dan de pagina "onbereikbaar").
	c.Close()
	waitFor(t, "edge ziet verbreking", func() bool { return !e.edge.Status()[0].Connected })
	if code, body := e.get("site.example.test", "/"); code != http.StatusBadGateway || !strings.Contains(body, "relay_offline") {
		t.Fatal(code, body)
	}
}

func TestRelayHostsUpdateKeepsTunnel(t *testing.T) {
	e := newEnv(t)
	c := e.start(secret)
	waitFor(t, "verbonden", func() bool { return c.Status().Connected })
	if code, _ := e.get("new.example.test", "/"); code != http.StatusMisdirectedRequest {
		t.Fatal(code)
	}
	if !e.edge.SetClients(clients("site.example.test", "new.example.test")) {
		t.Fatal("hosts veranderd: SetClients moet true geven")
	}
	if e.edge.SetClients(clients("site.example.test", "new.example.test")) {
		t.Fatal("niets veranderd")
	}
	if code, _ := e.get("new.example.test", "/"); code != 200 {
		t.Fatal(code)
	}
	if code, _ := e.get("a.wild.test", "/"); code != http.StatusMisdirectedRequest {
		t.Fatal("wildcard is weg", code)
	}
	if s := c.Status(); !s.Connected || s.Reconnects != 0 {
		t.Fatal("tunnel moet blijven staan", s)
	}
	// Ander geheim: de oude tunnel valt weg en de client komt er niet meer in.
	cs := clients("site.example.test")
	cs[0].Secret = "rotated"
	e.edge.SetClients(cs)
	waitFor(t, "verbroken met fout", func() bool {
		s := c.Status()
		return !s.Connected && s.LastError != nil && strings.Contains(*s.LastError, "401")
	})
	// Client verwijderd: 421 voor zijn hostnamen.
	e.edge.SetClients(nil)
	if code, _ := e.get("site.example.test", "/"); code != http.StatusMisdirectedRequest {
		t.Fatal(code)
	}
}

func TestRelayWrongSecretRejected(t *testing.T) {
	e := newEnv(t)
	c := e.start("not-the-secret")
	waitFor(t, "geweigerd", func() bool {
		s := c.Status()
		return s.LastError != nil && strings.Contains(*s.LastError, "HTTP 401")
	})
	if c.Status().Connected {
		t.Fatal("mag niet verbinden")
	}
	if s := e.edge.Status()[0]; s.Connected || s.LastError == nil || !strings.Contains(*s.LastError, "signature") {
		t.Fatal(s)
	}
}

// Een andere "A" (zonder het geheim) die de upgrade gewoon accepteert: B gebruikt de verbinding niet.
func TestRelayClientRejectsOtherEdge(t *testing.T) {
	var opened atomic.Int32
	fake := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, http.Header{HdrProof: {"00"}})
		if err != nil {
			return
		}
		sess, err := yamux.Server(newWSConn(ws), yamuxConfig())
		if err != nil {
			return
		}
		defer sess.Close()
		st, err := sess.Open()
		if err != nil {
			return
		}
		_, _ = io.WriteString(st, "GET /api/system HTTP/1.1\r\nHost: node2.test\r\n\r\n")
		buf := make([]byte, 64)
		_ = st.SetReadDeadline(time.Now().Add(time.Second))
		if n, _ := st.Read(buf); n > 0 {
			opened.Add(1)
		}
	}))
	defer fake.Close()
	roots := x509.NewCertPool()
	roots.AddCert(fake.Certificate())
	c := &Client{Self: "node2.test", API: apiHandler(), RootCAs: roots, MinBackoff: 20 * time.Millisecond, MaxBackoff: 50 * time.Millisecond}
	defer c.Close()
	c.Set(&EdgeConfig{NodeID: 1, URL: fake.URL, Fqdn: "node1.test", ClientID: 2, Secret: secret})
	waitFor(t, "bewijs geweigerd", func() bool {
		s := c.Status()
		return s.LastError != nil && *s.LastError == ErrProof.Error()
	})
	time.Sleep(200 * time.Millisecond)
	if c.Status().Connected || opened.Load() != 0 {
		t.Fatal("B mag geen verkeer van een andere edge beantwoorden")
	}

	// Ook een echte edge zonder TLS-vertrouwen (ander certificaat) wordt geweigerd.
	e := newEnv(t)
	c2 := &Client{Self: "node2.test", API: apiHandler(), RootCAs: x509.NewCertPool(), MinBackoff: 20 * time.Millisecond}
	defer c2.Close()
	c2.Set(&EdgeConfig{NodeID: 1, URL: e.tunnel.URL, Fqdn: "node1.test", ClientID: 2, Secret: secret})
	waitFor(t, "tls-fout", func() bool {
		s := c2.Status()
		return s.LastError != nil && strings.Contains(*s.LastError, "certificate")
	})
}

func TestRelayUnknownNodeRefreshesConfig(t *testing.T) {
	e := newEnv(t)
	e.edge.SetClients(nil)
	var refreshed atomic.Int32
	e.edge.Refresh = func() {
		refreshed.Add(1)
		e.edge.SetClients(clients("site.example.test"))
	}
	c := e.start(secret)
	waitFor(t, "verbonden na refresh", func() bool { return c.Status().Connected })
	if refreshed.Load() != 1 {
		t.Fatal(refreshed.Load())
	}
}

func TestRelayReplayAndSkew(t *testing.T) {
	e := newEnv(t)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := strings.Repeat("ab", 16)
	hdr := http.Header{HdrNode: {"2"}, HdrTime: {ts}, HdrNonce: {nonce}, HdrSig: {clientSig(secret, "node1.test", 2, ts, nonce)}}
	d := websocket.Dialer{TLSClientConfig: e.tunnel.Client().Transport.(*http.Transport).TLSClientConfig}
	u := strings.Replace(e.tunnel.URL, "https://", "wss://", 1) + TunnelPath
	ws, res, err := d.Dial(u, hdr)
	if err != nil {
		t.Fatal(err)
	}
	if res.Header.Get(HdrProof) != edgeProof(secret, "node1.test", 2, nonce) {
		t.Fatal("proof")
	}
	ws.Close()
	if _, res, err := d.Dial(u, hdr); err == nil || res.StatusCode != 401 {
		t.Fatal("replay moet geweigerd worden")
	}
	old := strconv.FormatInt(time.Now().Add(-10*time.Minute).Unix(), 10)
	nonce2 := strings.Repeat("cd", 16)
	hdr2 := http.Header{HdrNode: {"2"}, HdrTime: {old}, HdrNonce: {nonce2}, HdrSig: {clientSig(secret, "node1.test", 2, old, nonce2)}}
	if _, res, err := d.Dial(u, hdr2); err == nil || res.StatusCode != 401 {
		t.Fatal("oude tijd moet geweigerd worden")
	}
	// Onbekende node.
	hdr3 := http.Header{HdrNode: {"9"}, HdrTime: {ts}, HdrNonce: {strings.Repeat("ef", 16)}, HdrSig: {"x"}}
	if _, res, err := d.Dial(u, hdr3); err == nil || res.StatusCode != 403 {
		t.Fatal("onbekende node moet 403 krijgen")
	}
	// Handtekening is gebonden aan de edge: dezelfde handtekening voor een andere edge-naam faalt.
	e.edge.Self = "node3.test"
	nonce4 := strings.Repeat("12", 16)
	hdr4 := http.Header{HdrNode: {"2"}, HdrTime: {ts}, HdrNonce: {nonce4}, HdrSig: {clientSig(secret, "node1.test", 2, ts, nonce4)}}
	if _, res, err := d.Dial(u, hdr4); err == nil || res.StatusCode != 401 {
		t.Fatal("andere edge-naam moet geweigerd worden")
	}
}

func TestRelayNodeDomainsCannotBeHijacked(t *testing.T) {
	e := &Edge{Self: "node1.test", Dial: "unix//x"}
	e.SetClients([]ClientConfig{
		{NodeID: 2, Fqdn: "node2.test", Secret: "a", Hosts: []Host{{Host: "node3.test"}, {Host: "node1.test"}}},
		{NodeID: 3, Fqdn: "node3.test", Secret: "b"},
	})
	if c := e.lookup("node3.test"); c == nil || c.cfg.NodeID != 3 {
		t.Fatal("node3.test hoort bij node 3")
	}
	if e.lookup("node1.test") != nil {
		t.Fatal("het eigen domein van de edge wordt nooit doorgestuurd")
	}
	n := 0
	for _, r := range e.Routes() {
		if r.Host == "node3.test" {
			n++
		}
		if r.Host == "node1.test" {
			t.Fatal("geen route voor het eigen domein")
		}
	}
	if n != 1 {
		t.Fatal(n)
	}
}

func TestRelayRoutes(t *testing.T) {
	e := &Edge{Dial: "unix//run/panel/relay.sock"}
	e.SetClients([]ClientConfig{
		{NodeID: 2, Fqdn: "Node2.Test.", Secret: "x", Hosts: []Host{{Host: "a.test"}, {Host: "*.w.test", Wildcard: true, DNSChallenge: &DNSChallenge{Provider: "cloudflare", APIToken: "tok"}}, {Host: "bad host"}}},
		{NodeID: 3, Fqdn: "node3.test", Secret: ""}, // zonder geheim: genegeerd
	})
	rs := e.Routes()
	b, _ := json.Marshal(rs)
	if len(rs) != 3 || rs[0].Host != "*.w.test" || !rs[0].Wildcard || rs[0].DNSChallenge == nil || rs[1].Host != "a.test" || rs[2].Host != "node2.test" || rs[2].Upstream.Dial != "unix//run/panel/relay.sock" {
		t.Fatal(string(b))
	}
}
