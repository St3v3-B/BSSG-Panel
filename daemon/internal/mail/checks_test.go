package mail

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"panel/daemon/internal/engine"
)

type fakeResolver struct {
	mu   sync.Mutex
	mx   map[string][]*net.MX
	ptr  map[string][]string
	ip   map[string][]net.IP
	host map[string][]string // ontbreekt = NXDOMAIN
	errs map[string]error
}

func (r *fakeResolver) LookupMX(_ context.Context, n string) ([]*net.MX, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.mx[n]; ok {
		return m, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: n, IsNotFound: true}
}

func (r *fakeResolver) LookupAddr(_ context.Context, a string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.ptr[a]; ok {
		return p, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: a, IsNotFound: true}
}

func (r *fakeResolver) LookupIP(_ context.Context, network, h string) ([]net.IP, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []net.IP
	for _, ip := range r.ip[h] {
		if (network == "ip4") == (ip.To4() != nil) {
			out = append(out, ip)
		}
	}
	if len(out) == 0 {
		return nil, &net.DNSError{Err: "no such host", Name: h, IsNotFound: true}
	}
	return out, nil
}

func (r *fakeResolver) LookupHost(_ context.Context, h string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err, ok := r.errs[h]; ok {
		return nil, err
	}
	if a, ok := r.host[h]; ok {
		return a, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: h, IsNotFound: true}
}

// smtpServer is een net.Conn die een 220-groet stuurt.
func smtpConn(greeting string) net.Conn {
	c, s := net.Pipe()
	go func() {
		defer s.Close()
		_, _ = s.Write([]byte(greeting))
		buf := make([]byte, 64)
		_, _ = s.Read(buf)
	}()
	return c
}

func freePorts(t *testing.T, n int) []int {
	t.Helper()
	var out []int
	var ls []net.Listener
	for range n {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		ls = append(ls, l)
		out = append(out, l.Addr().(*net.TCPAddr).Port)
	}
	for _, l := range ls {
		l.Close()
	}
	return out
}

// tlsServer start een TLS-server op 127.0.0.1 met een certificaat voor host, getekend door een eigen CA.
func tlsServer(t *testing.T, host string, notAfter time.Time) (string, *x509.CertPool) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(365 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, _ := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	caCert, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, _ := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caKey)
	cfg := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	l, err := tls.Listen("tcp", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { _ = c.(*tls.Conn).Handshake(); c.Close() }()
		}
	}()
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	return l.Addr().String(), pool
}

type harness struct {
	s       *Service
	fd      *FakeDocker
	res     *fakeResolver
	bl      *fakeResolver
	ports   []int
	tlsAddr string
	// blockOutbound / closedInbound sturen Dial.
	mu            sync.Mutex
	blockOutbound bool
	closedInbound map[int]bool
	listeners     []Listener
	ntpOffset     time.Duration
	diskFree      uint64
}

const (
	pubV4 = "203.0.113.10"
	pubV6 = "2001:db8::10"
	host  = "mail.panel.test"
)

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{closedInbound: map[int]bool{}, diskFree: 50 << 30}
	h.ports = freePorts(t, 4)
	addr, pool := tlsServer(t, host, time.Now().Add(60*24*time.Hour))
	h.tlsAddr = addr
	h.res = &fakeResolver{
		mx: map[string][]*net.MX{
			"gmail.com":   {{Host: "alt1.gmail-smtp-in.l.google.com.", Pref: 10}, {Host: "gmail-smtp-in.l.google.com.", Pref: 5}},
			"outlook.com": {{Host: "outlook-com.olc.protection.outlook.com.", Pref: 5}},
		},
		ptr: map[string][]string{pubV4: {"Mail.Panel.Test."}, pubV6: {"mail.panel.test."}},
		ip:  map[string][]net.IP{host: {net.ParseIP(pubV4), net.ParseIP(pubV6)}},
	}
	h.bl = &fakeResolver{host: map[string][]string{}, errs: map[string]error{}}
	fd := NewFakeDocker()
	fd.Add(engine.ContainerSummary{ID: strings.Repeat("p", 64), Name: "panel-postfix", Labels: mailLabels, State: "running",
		Ports: []engine.PublishedPort{{HostIP: "0.0.0.0", HostPort: h.ports[0], Proto: "tcp"}}})
	fd.Handler = func(c string, argv []string, _ string) (string, string, int, bool) {
		if c == "panel-postfix" && argv[0] == "postconf" {
			return "mail.panel.test\n", "", 0, true
		}
		return "", "", 0, false
	}
	h.fd = fd
	s := New(Config{Hostname: host, EnvFile: filepath.Join(t.TempDir(), "none.env"), CaddyTLSAddr: h.tlsAddr}, fd, nil)
	realDial := (&net.Dialer{}).DialContext
	s.Checks = CheckEnv{
		Resolver: h.res,
		DNSBL:    h.bl,
		TLSRoots: pool,
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			hst, p, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(p)
			h.mu.Lock()
			defer h.mu.Unlock()
			switch {
			case addr == h.tlsAddr:
				return realDial(ctx, network, addr)
			case port == 2525:
				if h.blockOutbound {
					return nil, errors.New("connect: connection timed out")
				}
				return smtpConn("220-" + hst + " ESMTP\r\n220 ready\r\n"), nil
			case hst == pubV4 || hst == pubV6:
				if h.closedInbound[port] {
					return nil, errors.New("connect: connection refused")
				}
				return realDial(ctx, "tcp", net.JoinHostPort("127.0.0.1", p))
			}
			return nil, errors.New("unexpected dial " + addr)
		},
		Listen: func(network, addr string) (net.Listener, error) {
			_, p, _ := net.SplitHostPort(addr)
			return net.Listen("tcp", "127.0.0.1:"+p)
		},
		NTP: func(context.Context, string) (time.Duration, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.ntpOffset, nil
		},
		DetectIP: func(_ context.Context, v6 bool) (string, error) {
			if v6 {
				return pubV6, nil
			}
			return pubV4, nil
		},
		Listeners: func([]int) ([]Listener, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.listeners, nil
		},
		InContainer: func(pid int, id string) bool { return pid == 42 && id == strings.Repeat("p", 64) },
		DiskFree: func(string) (uint64, uint64, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			return 100 << 30, h.diskFree, nil
		},
		LocalIPs:     func() []netip.Addr { return nil },
		InboundPorts: h.ports,
		OutboundPort: 2525,
		CheckTimeout: 5 * time.Second,
	}
	h.s = s
	return h
}

func (h *harness) run(t *testing.T, req CheckRequest) map[string]Check {
	t.Helper()
	if req.MailHostname == "" {
		req.MailHostname = host
	}
	start := time.Now()
	rep, err := h.s.RunChecks(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("checks took %s", time.Since(start))
	}
	if len(rep.Checks) != len(CheckIDs) {
		t.Fatalf("%d checks", len(rep.Checks))
	}
	out := map[string]Check{}
	for i, c := range rep.Checks {
		if c.ID != CheckIDs[i] {
			t.Fatalf("order: %d %s", i, c.ID)
		}
		out[c.ID] = c
	}
	return out
}

func TestChecksAllGreen(t *testing.T) {
	h := newHarness(t)
	got := h.run(t, CheckRequest{})
	for _, id := range CheckIDs {
		if !got[id].OK {
			t.Errorf("%s not ok: %s (%v)", id, got[id].Detail, got[id].Data)
		}
	}
	if got[CheckClock].Required || got[CheckDisk].Required || !got[CheckPTR].Required || !got[CheckBlacklists].Required {
		t.Fatal("required flags")
	}
	if d := got[CheckCertificate].Data["days_left"].(int); d < 58 || d > 60 {
		t.Fatalf("days_left %d", d)
	}
	if got[CheckHELO].Data["source"] != "postfix" {
		t.Fatalf("helo %v", got[CheckHELO].Data)
	}
	// Inkomend: de poorten zijn lokaal vrij, dus via de tijdelijke listener, ook voor IPv6.
	b, _ := json.Marshal(got[CheckInboundPorts].Data["ports"])
	if !strings.Contains(string(b), `"probe":"temporary_listener"`) || !strings.Contains(string(b), pubV6) {
		t.Fatalf("inbound %s", b)
	}
	// Spamhaus doet ook IPv6, de rest niet: 4 + 1 lookups.
	if res := got[CheckBlacklists].Data["results"].([]blResult); len(res) != 5 {
		t.Fatalf("blacklists %+v", res)
	}
}

func TestChecksFailures(t *testing.T) {
	h := newHarness(t)
	h.res.ptr[pubV4] = []string{"static.10.113.0.203.provider.test."}
	h.res.ip["static.10.113.0.203.provider.test"] = []net.IP{net.ParseIP("198.51.100.1")}
	h.blockOutbound = true
	h.closedInbound[h.ports[1]] = true
	h.listeners = []Listener{
		{Addr: "0.0.0.0", Port: h.ports[2], PID: 99, Process: "exim4"},
		{Addr: "0.0.0.0", Port: h.ports[0], PID: 7, Process: "docker-proxy"}, // van panel-postfix: toegestaan
		{Addr: "::", Port: h.ports[3], PID: 42, Process: "dovecot"},          // in de postfix-container: toegestaan
	}
	h.fd.Add(engine.ContainerSummary{ID: "other", Name: "someone-smtp", Labels: map[string]string{}, State: "running",
		Ports: []engine.PublishedPort{{HostIP: "0.0.0.0", HostPort: h.ports[1], Proto: "tcp"}}})
	h.ntpOffset = -3 * time.Second
	h.diskFree = 5 << 30
	h.s.cfg.CaddyTLSAddr = "127.0.0.1:1"
	rev4, _ := ReverseIP(pubV4)
	h.bl.host[rev4+".b.barracudacentral.org."] = []string{"127.0.0.2"}
	h.bl.host[rev4+".zen.spamhaus.org."] = []string{"127.255.255.254"}
	got := h.run(t, CheckRequest{})
	for _, id := range CheckIDs {
		if got[id].OK {
			t.Errorf("%s unexpectedly ok: %s", id, got[id].Detail)
		}
	}
	if !strings.Contains(got[CheckPTR].Detail, "static.10.113.0.203.provider.test") || got[CheckPTR].Hint == "" {
		t.Fatalf("ptr %s", got[CheckPTR].Detail)
	}
	if !strings.Contains(got[CheckFCrDNS].Detail, "198.51.100.1") {
		t.Fatalf("fcrdns %s", got[CheckFCrDNS].Detail)
	}
	if !strings.Contains(got[CheckBlacklists].Detail, "Barracuda") {
		t.Fatalf("bl %s", got[CheckBlacklists].Detail)
	}
	if !strings.Contains(got[CheckInboundPorts].Detail, net.JoinHostPort(pubV4, strconv.Itoa(h.ports[1]))) {
		t.Fatalf("inbound %s", got[CheckInboundPorts].Detail)
	}
	pf := got[CheckPortsFree].Detail
	if !strings.Contains(pf, "exim4 (pid 99)") || !strings.Contains(pf, "container someone-smtp") || strings.Contains(pf, "docker-proxy") || strings.Contains(pf, "dovecot") {
		t.Fatalf("ports_free %s", pf)
	}
	if !strings.Contains(got[CheckOutbound25].Detail, "blocked") {
		t.Fatalf("outbound %s", got[CheckOutbound25].Detail)
	}
}

func TestBlacklistSpamhausRefused(t *testing.T) {
	h := newHarness(t)
	rev4, _ := ReverseIP(pubV4)
	h.bl.host[rev4+".zen.spamhaus.org."] = []string{"127.255.255.254"}
	h.bl.errs[rev4+".bl.spamcop.net."] = errors.New("i/o timeout")
	c := h.run(t, CheckRequest{})[CheckBlacklists]
	if c.OK || !strings.Contains(c.Detail, "could not verify") || !strings.Contains(c.Detail, "refused") || !strings.Contains(c.Detail, "not checked: SpamCop") {
		t.Fatalf("%+v", c)
	}
	// Alleen SpamCop onbekend: wel ok, maar gemeld.
	delete(h.bl.host, rev4+".zen.spamhaus.org.")
	c = h.run(t, CheckRequest{})[CheckBlacklists]
	if !c.OK || !strings.Contains(c.Detail, "not checked: SpamCop") {
		t.Fatalf("%+v", c)
	}
}

func TestChecksNoIP(t *testing.T) {
	h := newHarness(t)
	h.s.Checks.DetectIP = func(context.Context, bool) (string, error) { return "", errors.New("no route") }
	got := h.run(t, CheckRequest{})
	for _, id := range []string{CheckInboundPorts, CheckPTR, CheckFCrDNS, CheckHELO, CheckBlacklists} {
		if got[id].OK || !strings.Contains(got[id].Detail, "public IPv4 unknown: no route") {
			t.Fatalf("%s: %+v", id, got[id])
		}
	}
	if !got[CheckOutbound25].OK || !got[CheckCertificate].OK {
		t.Fatal("independent checks should still pass")
	}
	// Gegeven IP in de aanvraag, IPv6 = null: geen detectie, alleen IPv4.
	v4 := pubV4
	got = h.run(t, CheckRequest{PublicIPv4: &v4})
	if !got[CheckPTR].OK || strings.Contains(got[CheckPTR].Detail, pubV6) {
		t.Fatalf("%+v", got[CheckPTR])
	}
}

func TestCertificateWrongHostAndExpired(t *testing.T) {
	addr, pool := tlsServer(t, "other.panel.test", time.Now().Add(24*time.Hour))
	e := CheckEnv{Dial: (&net.Dialer{}).DialContext, Now: time.Now, TLSRoots: pool}
	c := checkCertificate(context.Background(), &e, addr, host)
	if c.OK || !strings.Contains(c.Detail, "not valid") || c.Data["valid"] != false {
		t.Fatalf("%+v", c)
	}
	addr, pool = tlsServer(t, host, time.Now().Add(24*time.Hour))
	e.TLSRoots = pool
	e.Now = func() time.Time { return time.Now().Add(48 * time.Hour) }
	if c := checkCertificate(context.Background(), &e, addr, host); c.OK {
		t.Fatalf("expired: %+v", c)
	}
	if c := checkCertificate(context.Background(), &e, "127.0.0.1:1", host); c.OK || !strings.Contains(c.Detail, "cannot reach Caddy") {
		t.Fatalf("%+v", c)
	}
}

func TestValidateRequest(t *testing.T) {
	s := func(v string) *string { return &v }
	for _, r := range []CheckRequest{
		{MailHostname: ""}, {MailHostname: "mail panel.test"}, {MailHostname: host, PublicIPv4: s(pubV6)},
		{MailHostname: host, PublicIPv6: s(pubV4)}, {MailHostname: host, PublicIPv4: s("10.0.0.300")}, {MailHostname: host, PublicIPv4: s("127.0.0.1")},
	} {
		if err := ValidateRequest(&r); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%+v: %v", r, err)
		}
	}
	r := CheckRequest{MailHostname: "Mail.Panel.Test.", PublicIPv4: s(" 203.0.113.10 "), PublicIPv6: s("")}
	if err := ValidateRequest(&r); err != nil || r.MailHostname != host || *r.PublicIPv4 != pubV4 || r.PublicIPv6 != nil {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestReverseIP(t *testing.T) {
	if r, _ := ReverseIP("192.0.2.1"); r != "1.2.0.192" {
		t.Fatal(r)
	}
	r, _ := ReverseIP("2001:db8::1")
	if r != "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2" {
		t.Fatal(r)
	}
}

func TestParseProcNet(t *testing.T) {
	tcp := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0019 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:03E1 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0019 0100007F:A000 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0
   3: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0
`
	got := ParseProcNet(tcp, false, MailPorts)
	if len(got) != 2 || got[0].Addr != "0.0.0.0" || got[0].Port != 25 || got[0].Inode != "12345" || got[1].Addr != "127.0.0.1" || got[1].Port != 993 {
		t.Fatalf("%+v", got)
	}
	tcp6 := `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:01D1 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:024B 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 223 1 0000000000000000 100 0 0 10 0
`
	got = ParseProcNet(tcp6, true, MailPorts)
	if len(got) != 2 || got[0].Addr != "::" || got[0].Port != 465 || got[1].Addr != "::1" || got[1].Port != 587 {
		t.Fatalf("%+v", got)
	}
}

func TestProcListenersFakeRoot(t *testing.T) {
	root := t.TempDir()
	old := procRoot
	procRoot = root
	t.Cleanup(func() { procRoot = old })
	os.MkdirAll(filepath.Join(root, "net"), 0o755)
	os.WriteFile(filepath.Join(root, "net", "tcp"), []byte("hdr\n   0: 00000000:0019 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777 1\n"), 0o644)
	os.MkdirAll(filepath.Join(root, "1234", "fd"), 0o755)
	os.WriteFile(filepath.Join(root, "1234", "comm"), []byte("master\n"), 0o644)
	os.Symlink("socket:[777]", filepath.Join(root, "1234", "fd", "3"))
	ls, err := ProcListeners(MailPorts)
	if err != nil || len(ls) != 1 || ls[0].PID != 1234 || ls[0].Process != "master" || ls[0].Port != 25 {
		t.Fatalf("%+v %v", ls, err)
	}
}

func TestNTPQuery(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 48)
		n, from, err := pc.ReadFrom(buf)
		if err != nil || n < 48 {
			return
		}
		resp := make([]byte, 48)
		resp[0], resp[1] = 0x24, 2 // versie 4, server; stratum 2
		copy(resp[24:32], buf[40:48])
		ts := toNTP(time.Now().Add(5 * time.Second))
		binary.BigEndian.PutUint64(resp[32:], ts)
		binary.BigEndian.PutUint64(resp[40:], ts)
		_, _ = pc.WriteTo(resp, from)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	off, err := ntpQuery(ctx, pc.LocalAddr().String(), (&net.Dialer{}).DialContext, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if off < 4900*time.Millisecond || off > 5100*time.Millisecond {
		t.Fatalf("offset %s", off)
	}
}

func TestNTPRoundTrip(t *testing.T) {
	now := time.Unix(1700000000, 123456789)
	if d := fromNTP(toNTP(now)).Sub(now); d > time.Microsecond || d < -time.Microsecond {
		t.Fatal(d)
	}
}

func TestDNSBLResolverFromUnbound(t *testing.T) {
	fd := NewFakeDocker()
	fd.Add(engine.ContainerSummary{ID: "u", Name: "panel-unbound", Labels: mailLabels, State: "running"})
	fd.IPMap["u"] = map[string]string{"panel-mail": "172.30.0.5"}
	s := New(Config{EnvFile: "/nonexistent"}, fd, nil)
	if _, name := s.dnsblResolver(context.Background()); name != "panel-unbound (172.30.0.5:53)" {
		t.Fatal(name)
	}
	s = New(Config{EnvFile: "/nonexistent", DNSBLResolver: "127.0.0.1:5353"}, fd, nil)
	if _, name := s.dnsblResolver(context.Background()); name != "127.0.0.1:5353" {
		t.Fatal(name)
	}
	s = New(Config{EnvFile: "/nonexistent"}, NewFakeDocker(), nil)
	if _, name := s.dnsblResolver(context.Background()); name != "system" {
		t.Fatal(name)
	}
}
