package mail

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Check-ids (vast; de UI vertaalt ze).
const (
	CheckOutbound25   = "outbound_25"
	CheckInboundPorts = "inbound_ports"
	CheckPTR          = "ptr"
	CheckFCrDNS       = "fcrdns"
	CheckHELO         = "helo"
	CheckBlacklists   = "blacklists"
	CheckCertificate  = "certificate"
	CheckPortsFree    = "ports_free"
	CheckClock        = "clock"
	CheckDisk         = "disk"
)

// CheckIDs in de volgorde van het rapport.
var CheckIDs = []string{CheckOutbound25, CheckInboundPorts, CheckPTR, CheckFCrDNS, CheckHELO, CheckBlacklists,
	CheckCertificate, CheckPortsFree, CheckClock, CheckDisk}

// MailPorts zijn de publieke mailpoorten (4190/ManageSieve hoort er in deze ronde niet bij).
var MailPorts = []int{25, 465, 587, 993}

// CheckRequest is het MailCheckRequest-schema.
type CheckRequest struct {
	MailHostname string  `json:"mail_hostname"`
	PublicIPv4   *string `json:"public_ipv4"`
	PublicIPv6   *string `json:"public_ipv6"`
}

// Check is één regel van het rapport (MailCheck).
type Check struct {
	ID       string         `json:"id"`
	OK       bool           `json:"ok"`
	Required bool           `json:"required"`
	Detail   string         `json:"detail"`
	Hint     string         `json:"hint,omitempty"`
	Data     map[string]any `json:"data,omitempty"`
}

// Report is het MailCheckReport-schema.
type Report struct {
	CheckedAt time.Time `json:"checked_at"`
	Checks    []Check   `json:"checks"`
}

// Resolver is het deel van *net.Resolver dat de checks gebruiken.
type Resolver interface {
	LookupMX(ctx context.Context, name string) ([]*net.MX, error)
	LookupAddr(ctx context.Context, addr string) ([]string, error)
	LookupIP(ctx context.Context, network, host string) ([]net.IP, error)
	LookupHost(ctx context.Context, host string) ([]string, error)
}

// Listener is een luisterende TCP-socket op de host.
type Listener struct {
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
	PID     int    `json:"pid,omitempty"`
	Process string `json:"process,omitempty"`
}

// CheckEnv bevat de afhankelijkheden van de checks; lege velden krijgen de echte implementatie. Tests vullen ze
// met fakes, zodat geen check internet of root nodig heeft.
type CheckEnv struct {
	Resolver Resolver
	// DNSBL: resolver voor de blacklists; nil = MAIL_DNSBL_RESOLVER (standaard panel-unbound, anders systeem).
	DNSBL Resolver
	Dial  func(ctx context.Context, network, addr string) (net.Conn, error)
	// Listen opent tijdelijk een poort voor de inkomende check als die nog vrij is (nil = net.Listen).
	Listen func(network, addr string) (net.Listener, error)
	Now    func() time.Time
	// NTP geeft de klokafwijking (server − lokaal).
	NTP func(ctx context.Context, server string) (time.Duration, error)
	// DetectIP bepaalt het publieke IPv4- of IPv6-adres.
	DetectIP func(ctx context.Context, v6 bool) (string, error)
	// Listeners geeft de luisterende TCP-sockets op deze poorten (nil = /proc/net/tcp{,6}).
	Listeners func(ports []int) ([]Listener, error)
	// InContainer zegt of pid in de container met dit id draait (nil = /proc/<pid>/cgroup).
	InContainer func(pid int, containerID string) bool
	DiskFree    func(path string) (total, free uint64, err error)
	LocalIPs    func() []netip.Addr
	// TLSRoots: vertrouwde roots voor de certificaatcheck (nil = systeem).
	TLSRoots *x509.CertPool
	// Poorten (tests: willekeurige vrije poorten; nooit de echte).
	InboundPorts []int
	OutboundPort int
	// Timeouts (0 = standaard).
	CheckTimeout time.Duration // per check, standaard 10 s
	TotalTimeout time.Duration // hele aanroep, standaard 30 s
}

func (s *Service) env() CheckEnv {
	e := s.Checks
	if e.Resolver == nil {
		e.Resolver = net.DefaultResolver
	}
	if e.Dial == nil {
		d := &net.Dialer{}
		e.Dial = d.DialContext
	}
	if e.Listen == nil {
		e.Listen = net.Listen
	}
	if e.Now == nil {
		e.Now = time.Now
	}
	if e.NTP == nil {
		e.NTP = func(ctx context.Context, server string) (time.Duration, error) { return NTPOffset(ctx, server, e.Dial) }
	}
	if e.DetectIP == nil {
		e.DetectIP = DetectPublicIP
	}
	if e.Listeners == nil {
		e.Listeners = ProcListeners
	}
	if e.InContainer == nil {
		e.InContainer = pidInContainer
	}
	if e.DiskFree == nil {
		e.DiskFree = diskFree
	}
	if e.LocalIPs == nil {
		e.LocalIPs = localIPs
	}
	if len(e.InboundPorts) == 0 {
		e.InboundPorts = MailPorts
	}
	if e.OutboundPort == 0 {
		e.OutboundPort = 25
	}
	if e.CheckTimeout == 0 {
		e.CheckTimeout = 10 * time.Second
	}
	if e.TotalTimeout == 0 {
		e.TotalTimeout = 30 * time.Second
	}
	return e
}

// ipInfo is een publiek adres met zijn PTR-namen.
type ipInfo struct {
	Family string // ipv4 of ipv6
	IP     string
	PTR    []string
	PTRErr error
}

// ValidateRequest controleert hostnaam en IP's (400 bij een fout).
func ValidateRequest(r *CheckRequest) error {
	r.MailHostname = normHost(r.MailHostname)
	if !ValidDomain(r.MailHostname) {
		return fmt.Errorf("%w: mail_hostname", ErrInvalid)
	}
	for _, p := range []struct {
		v  **string
		v6 bool
	}{{&r.PublicIPv4, false}, {&r.PublicIPv6, true}} {
		if *p.v == nil || strings.TrimSpace(**p.v) == "" {
			*p.v = nil
			continue
		}
		a, err := netip.ParseAddr(strings.TrimSpace(**p.v))
		if err != nil || a.Is4() == p.v6 || a.Is4In6() || !a.IsGlobalUnicast() {
			return fmt.Errorf("%w: public_ipv%s", ErrInvalid, map[bool]string{false: "4", true: "6"}[p.v6])
		}
		str := a.String()
		*p.v = &str
	}
	return nil
}

// RunChecks voert alle checks parallel uit (per check ≤ CheckTimeout, samen ≤ TotalTimeout).
func (s *Service) RunChecks(ctx context.Context, req CheckRequest) (Report, error) {
	if err := ValidateRequest(&req); err != nil {
		return Report{}, err
	}
	e := s.env()
	ctx, cancel := context.WithTimeout(ctx, e.TotalTimeout)
	defer cancel()
	host := req.MailHostname

	results := map[string]Check{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	run := func(id string, required bool, fn func(ctx context.Context) Check) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, ccancel := context.WithTimeout(ctx, e.CheckTimeout)
			defer ccancel()
			done := make(chan Check, 1)
			go func() { done <- fn(cctx) }()
			var c Check
			select {
			case c = <-done:
			case <-cctx.Done():
				c = Check{Detail: "check timed out"}
			}
			c.ID, c.Required = id, required
			mu.Lock()
			results[id] = c
			mu.Unlock()
		}()
	}

	// Onafhankelijk van het publieke IP.
	run(CheckOutbound25, true, func(ctx context.Context) Check { return checkOutbound(ctx, &e) })
	run(CheckCertificate, true, func(ctx context.Context) Check { return checkCertificate(ctx, &e, s.cfg.CaddyTLSAddr, host) })
	run(CheckPortsFree, true, func(ctx context.Context) Check { return s.checkPortsFree(ctx, &e) })
	run(CheckClock, false, func(ctx context.Context) Check { return checkClock(ctx, &e, s.cfg.NTPServer) })
	run(CheckDisk, false, func(ctx context.Context) Check { return checkDisk(&e, s.cfg.DiskPath) })

	// Publieke IP's bepalen (≤ 5 s) en PTR's opzoeken (≤ 5 s), daarna de afhankelijke checks.
	ips, ipErrs := s.publicIPs(ctx, &e, req)
	var pwg sync.WaitGroup
	for i := range ips {
		pwg.Add(1)
		go func() {
			defer pwg.Done()
			pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
			defer pcancel()
			names, err := e.Resolver.LookupAddr(pctx, ips[i].IP)
			for _, n := range names {
				ips[i].PTR = append(ips[i].PTR, normHost(n))
			}
			ips[i].PTRErr = err
		}()
	}
	pwg.Wait()
	// Niet verplicht: vanaf de host zelf is bereikbaarheid van buitenaf niet betrouwbaar te bepalen (NAT/hairpin,
	// eigen IP via lo); een rode uitslag is een waarschuwing, geen blokkade.
	run(CheckInboundPorts, false, func(ctx context.Context) Check { return checkInbound(ctx, &e, ips, ipErrs) })
	run(CheckPTR, true, func(context.Context) Check { return checkPTR(host, ips, ipErrs) })
	run(CheckFCrDNS, true, func(ctx context.Context) Check { return checkFCrDNS(ctx, &e, host, ips, ipErrs) })
	run(CheckHELO, true, func(ctx context.Context) Check { return s.checkHELO(ctx, host, ips, ipErrs) })
	run(CheckBlacklists, true, func(ctx context.Context) Check { return s.checkBlacklists(ctx, &e, ips, ipErrs) })
	wg.Wait()

	rep := Report{CheckedAt: e.Now().UTC(), Checks: make([]Check, 0, len(CheckIDs))}
	for _, id := range CheckIDs {
		rep.Checks = append(rep.Checks, results[id])
	}
	return rep, nil
}

// publicIPs: uit de aanvraag, anders MAIL_PUBLIC_IPV4/6, anders detectie. IPv6 is optioneel.
func (s *Service) publicIPs(ctx context.Context, e *CheckEnv, req CheckRequest) ([]ipInfo, []string) {
	type res struct {
		ip  string
		err error
	}
	get := func(given *string, envKey, envDef string, v6 bool) res {
		if given != nil {
			return res{ip: *given}
		}
		if v := strings.TrimSpace(s.envOr(envKey, envDef)); v != "" {
			if a, err := netip.ParseAddr(v); err == nil && a.Is6() == v6 {
				return res{ip: a.String()}
			}
		}
		dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		ip, err := e.DetectIP(dctx, v6)
		if err == nil {
			a, perr := netip.ParseAddr(ip)
			if perr != nil || a.Is6() != v6 {
				return res{err: fmt.Errorf("detection returned %q", ip)}
			}
			ip = a.String()
		}
		return res{ip: ip, err: err}
	}
	var r4, r6 res
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); r4 = get(req.PublicIPv4, "MAIL_PUBLIC_IPV4", s.cfg.PublicIPv4, false) }()
	go func() { defer wg.Done(); r6 = get(req.PublicIPv6, "MAIL_PUBLIC_IPV6", s.cfg.PublicIPv6, true) }()
	wg.Wait()
	var ips []ipInfo
	var errs []string
	if r4.err != nil || r4.ip == "" {
		errs = append(errs, fmt.Sprintf("public IPv4 unknown: %v", r4.err))
	} else {
		ips = append(ips, ipInfo{Family: "ipv4", IP: r4.ip})
	}
	if r6.err == nil && r6.ip != "" {
		ips = append(ips, ipInfo{Family: "ipv6", IP: r6.ip})
	}
	return ips, errs
}

func hasV4(ips []ipInfo) bool {
	return slices.ContainsFunc(ips, func(i ipInfo) bool { return i.Family == "ipv4" })
}

// noIP: de check kan niet zonder publiek IPv4.
func noIP(ipErrs []string) Check {
	return Check{Detail: strings.Join(ipErrs, "; "), Hint: "Set MAIL_PUBLIC_IPV4 in panel.env or pass public_ipv4."}
}

// DetectPublicIP vraagt het publieke adres op bij api.ipify.org (IPv4) of api6.ipify.org (IPv6).
func DetectPublicIP(ctx context.Context, v6 bool) (string, error) {
	network, url := "tcp4", "https://api.ipify.org"
	if v6 {
		network, url = "tcp6", "https://api6.ipify.org"
	}
	d := &net.Dialer{}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
		return d.DialContext(ctx, network, addr)
	}}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return strings.TrimSpace(string(b)), nil
}

// --- outbound_25 ---

// smtpBanner verbindt met addr en leest de 220-groet (meerregelig toegestaan); stuurt daarna QUIT.
func smtpBanner(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error), addr string) (string, error) {
	conn, err := dial(ctx, "tcp", addr)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	for len(buf) < 4096 {
		n, err := conn.Read(tmp)
		buf = append(buf, tmp[:n]...)
		lines := strings.Split(string(buf), "\n")
		for _, l := range lines[:len(lines)-1] {
			l = strings.TrimRight(l, "\r")
			if len(l) >= 4 && l[3] == ' ' {
				if !strings.HasPrefix(l, "220") {
					return l, fmt.Errorf("unexpected greeting %q", trim(l))
				}
				_, _ = conn.Write([]byte("QUIT\r\n"))
				return l, nil
			}
		}
		if err != nil {
			return "", fmt.Errorf("no SMTP greeting: %w", err)
		}
	}
	return "", errors.New("greeting too long")
}

func checkOutbound(ctx context.Context, e *CheckEnv) Check {
	domains := []string{"gmail.com", "outlook.com"}
	type res struct {
		Domain string `json:"domain"`
		MX     string `json:"mx,omitempty"`
		OK     bool   `json:"ok"`
		Banner string `json:"banner,omitempty"`
		Error  string `json:"error,omitempty"`
	}
	out := make([]res, len(domains))
	var wg sync.WaitGroup
	for i, d := range domains {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := res{Domain: d}
			mxs, err := e.Resolver.LookupMX(ctx, d)
			if err != nil || len(mxs) == 0 {
				r.Error = fmt.Sprintf("MX lookup failed: %v", err)
				out[i] = r
				return
			}
			sort.SliceStable(mxs, func(a, b int) bool { return mxs[a].Pref < mxs[b].Pref })
			for j, mx := range mxs {
				if j == 2 {
					break
				}
				r.MX = normHost(mx.Host)
				dctx, cancel := context.WithTimeout(ctx, 4*time.Second)
				banner, err := smtpBanner(dctx, e.Dial, net.JoinHostPort(r.MX, strconv.Itoa(e.OutboundPort)))
				cancel()
				if err == nil {
					r.OK, r.Banner, r.Error = true, trim(banner), ""
					break
				}
				r.Error = err.Error()
			}
			out[i] = r
		}()
	}
	wg.Wait()
	var okd, bad []string
	for _, r := range out {
		if r.OK {
			okd = append(okd, r.Domain)
		} else {
			bad = append(bad, r.Domain+": "+r.Error)
		}
	}
	c := Check{OK: len(okd) > 0, Data: map[string]any{"targets": out}}
	switch {
	case len(bad) == 0:
		c.Detail = "outgoing port 25 works (" + strings.Join(okd, ", ") + ")"
	case c.OK:
		c.Detail = "outgoing port 25 works (" + strings.Join(okd, ", ") + "); failed: " + strings.Join(bad, "; ")
	default:
		c.Detail = "outgoing port 25 blocked or unreachable: " + strings.Join(bad, "; ")
		c.Hint = "Your provider probably blocks outgoing port 25: ask them to open it, or configure a smarthost."
	}
	return c
}

// --- inbound_ports ---

type portResult struct {
	IP     string `json:"ip"`
	Port   int    `json:"port"`
	Open   bool   `json:"open"`
	Probe  string `json:"probe"` // "service" (er luisterde al iets) of "temporary_listener"
	Banner string `json:"banner,omitempty"`
	Error  string `json:"error,omitempty"`
}

func checkInbound(ctx context.Context, e *CheckEnv, ips []ipInfo, ipErrs []string) Check {
	if !hasV4(ips) {
		return noIP(ipErrs)
	}
	var mu sync.Mutex
	var results []portResult
	var wg sync.WaitGroup
	for _, p := range e.InboundPorts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rs := probePort(ctx, e, ips, p)
			mu.Lock()
			results = append(results, rs...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Slice(results, func(i, j int) bool {
		if results[i].IP != results[j].IP {
			return results[i].IP < results[j].IP
		}
		return results[i].Port < results[j].Port
	})
	var closed []string
	for _, r := range results {
		if !r.Open {
			closed = append(closed, net.JoinHostPort(r.IP, strconv.Itoa(r.Port)))
		}
	}
	local := false
	lips := e.LocalIPs()
	for _, ip := range ips {
		if a, err := netip.ParseAddr(ip.IP); err == nil && slices.Contains(lips, a) {
			local = true
		}
	}
	c := Check{OK: len(closed) == 0, Data: map[string]any{"ports": results, "closed": closed, "ip_on_this_host": local}}
	if c.OK {
		c.Detail = "ports " + joinInts(e.InboundPorts) + " reachable on " + ipList(ips)
		if local {
			c.Detail += " (tested from this host; an external firewall at your provider is not visible from here)"
		}
	} else {
		c.Detail = "not reachable from this host: " + strings.Join(closed, ", ") +
			" (warning only: the test runs from the server itself and cannot see reachability from the internet reliably)"
		c.Hint = "Open these ports in the firewall (and port-forward them to this machine when it is behind NAT). " +
			"Behind NAT without hairpinning this test from the host itself can fail although the ports are open; " +
			"verify from outside, e.g. with an online port checker."
	}
	return c
}

// probePort test één poort op alle IP's. Is de poort lokaal vrij, dan luistert de check er tijdelijk zelf op
// (de mailstack draait dan nog niet) en telt alleen een verbinding die echt binnenkomt.
func probePort(ctx context.Context, e *CheckEnv, ips []ipInfo, port int) []portResult {
	ln, lerr := e.Listen("tcp", ":"+strconv.Itoa(port))
	accepted := make(chan struct{}, 8)
	if lerr == nil {
		defer ln.Close()
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				_ = c.Close()
				select {
				case accepted <- struct{}{}:
				default:
				}
			}
		}()
	}
	var out []portResult
	for _, ip := range ips {
		r := portResult{IP: ip.IP, Port: port, Probe: "service"}
		addr := net.JoinHostPort(ip.IP, strconv.Itoa(port))
		dctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		if lerr == nil {
			r.Probe = "temporary_listener"
			conn, err := e.Dial(dctx, "tcp", addr)
			if err != nil {
				r.Error = err.Error()
			} else {
				_ = conn.Close()
				select {
				case <-accepted:
					r.Open = true
				case <-dctx.Done():
					r.Error = "connected, but not to this machine"
				}
			}
		} else if port == 25 || port == 587 {
			banner, err := smtpBanner(dctx, e.Dial, addr)
			r.Open, r.Banner = err == nil, trim(banner)
			if err != nil {
				r.Error = err.Error()
			}
		} else {
			conn, err := e.Dial(dctx, "tcp", addr)
			if err != nil {
				r.Error = err.Error()
			} else {
				r.Open = true
				_ = conn.Close()
			}
		}
		cancel()
		out = append(out, r)
	}
	return out
}

func joinInts(p []int) string {
	s := make([]string, len(p))
	for i, v := range p {
		s[i] = strconv.Itoa(v)
	}
	return strings.Join(s, "/")
}

func ipList(ips []ipInfo) string {
	s := make([]string, len(ips))
	for i, ip := range ips {
		s[i] = ip.IP
	}
	return strings.Join(s, ", ")
}

func localIPs() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []netip.Addr
	for _, a := range addrs {
		if p, err := netip.ParsePrefix(a.String()); err == nil {
			out = append(out, p.Addr())
		}
	}
	return out
}

// --- ptr / fcrdns / helo ---

func ptrData(ips []ipInfo) map[string]any {
	d := map[string]any{}
	for _, ip := range ips {
		m := map[string]any{"ip": ip.IP, "names": append([]string{}, ip.PTR...)}
		if ip.PTRErr != nil {
			m["error"] = ip.PTRErr.Error()
		}
		d[ip.Family] = m
	}
	return d
}

func checkPTR(host string, ips []ipInfo, ipErrs []string) Check {
	if !hasV4(ips) {
		return noIP(ipErrs)
	}
	var bad, good []string
	for _, ip := range ips {
		switch {
		case slices.Contains(ip.PTR, host):
			good = append(good, ip.IP+" → "+host)
		case len(ip.PTR) == 0:
			bad = append(bad, ip.IP+" has no PTR record")
		default:
			bad = append(bad, ip.IP+" → "+strings.Join(ip.PTR, ", "))
		}
	}
	c := Check{OK: len(bad) == 0, Data: ptrData(ips)}
	if c.OK {
		c.Detail = strings.Join(good, "; ")
	} else {
		c.Detail = "PTR must be exactly " + host + ": " + strings.Join(bad, "; ")
		c.Hint = "Set the reverse DNS (PTR) of the IP address to " + host + " at your hosting provider."
	}
	return c
}

func checkFCrDNS(ctx context.Context, e *CheckEnv, host string, ips []ipInfo, ipErrs []string) Check {
	if !hasV4(ips) {
		return noIP(ipErrs)
	}
	type res struct {
		IP       string   `json:"ip"`
		Name     string   `json:"name,omitempty"`
		Resolved []string `json:"resolved"`
		OK       bool     `json:"ok"`
	}
	var out []res
	var bad []string
	for _, ip := range ips {
		network := "ip4"
		if ip.Family == "ipv6" {
			network = "ip6"
		}
		want, _ := netip.ParseAddr(ip.IP)
		r := res{IP: ip.IP, Resolved: []string{}}
		names := ip.PTR
		if len(names) == 0 {
			bad = append(bad, ip.IP+": no PTR record")
			out = append(out, r)
			continue
		}
		for _, n := range names {
			got, _ := e.Resolver.LookupIP(ctx, network, n)
			r.Name = n
			r.Resolved = r.Resolved[:0]
			for _, g := range got {
				a, ok := netip.AddrFromSlice(g)
				if !ok {
					continue
				}
				a = a.Unmap()
				r.Resolved = append(r.Resolved, a.String())
				if a == want {
					r.OK = true
				}
			}
			if r.OK {
				break
			}
		}
		if !r.OK {
			kind := "A"
			if ip.Family == "ipv6" {
				kind = "AAAA"
			}
			bad = append(bad, fmt.Sprintf("%s record of %s is [%s], expected %s", kind, r.Name, strings.Join(r.Resolved, ", "), ip.IP))
		}
		out = append(out, r)
	}
	c := Check{OK: len(bad) == 0, Data: map[string]any{"results": out}}
	if c.OK {
		c.Detail = "forward-confirmed reverse DNS is correct"
	} else {
		c.Detail = strings.Join(bad, "; ")
		c.Hint = "Point the A (and AAAA) record of " + host + " to this server's address."
	}
	return c
}

func (s *Service) checkHELO(ctx context.Context, host string, ips []ipInfo, ipErrs []string) Check {
	name, source := host, "MAIL_HOSTNAME"
	if s.dock != nil && s.running(ctx, s.cfg.Postfix) {
		if out, err := s.exec(ctx, s.cfg.Postfix, nil, "postconf", "-h", "myhostname"); err == nil && strings.TrimSpace(out) != "" {
			name, source = normHost(out), "postfix"
		}
	}
	data := map[string]any{"myhostname": name, "source": source}
	if !hasV4(ips) {
		c := noIP(ipErrs)
		c.Data = data
		return c
	}
	var bad []string
	for _, ip := range ips {
		if !slices.Contains(ip.PTR, name) {
			ptr := strings.Join(ip.PTR, ", ")
			if ptr == "" {
				ptr = "none"
			}
			bad = append(bad, ip.IP+" PTR "+ptr)
		}
	}
	c := Check{OK: len(bad) == 0, Data: data}
	if c.OK {
		c.Detail = "HELO name " + name + " matches the PTR record"
	} else {
		c.Detail = "HELO name " + name + " (" + source + ") does not match: " + strings.Join(bad, "; ")
		c.Hint = "The panel sets Postfix myhostname to MAIL_HOSTNAME; make the PTR record equal to it."
	}
	return c
}

// --- blacklists ---

// DNSBL is één blacklist.
type DNSBL struct {
	Name     string
	Zone     string
	IPv6     bool // ondersteunt IPv6-lookups
	Spamhaus bool // 127.255.255.x = resolver geweigerd
	Required bool // moet gecontroleerd kunnen worden (anders check niet ok)
	Delist   string
}

// Blacklists die de check gebruikt.
var Blacklists = []DNSBL{
	{Name: "Spamhaus ZEN", Zone: "zen.spamhaus.org", IPv6: true, Spamhaus: true, Required: true, Delist: "https://check.spamhaus.org/"},
	{Name: "Barracuda", Zone: "b.barracudacentral.org", Delist: "https://www.barracudacentral.org/rbl/removal-request"},
	{Name: "SpamCop", Zone: "bl.spamcop.net", Delist: "https://www.spamcop.net/bl.shtml"},
	{Name: "UCEPROTECT", Zone: "dnsbl-1.uceprotect.net", Delist: "https://www.uceprotect.net/en/rblcheck.php"},
}

// ReverseIP geeft de omgekeerde notatie voor een DNSBL-lookup (1.2.3.4 → 4.3.2.1; IPv6 per nibble).
func ReverseIP(ip string) (string, error) {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return "", err
	}
	a = a.Unmap()
	b := a.AsSlice()
	var parts []string
	if a.Is4() {
		for i := len(b) - 1; i >= 0; i-- {
			parts = append(parts, strconv.Itoa(int(b[i])))
		}
	} else {
		const hex = "0123456789abcdef"
		for i := len(b) - 1; i >= 0; i-- {
			parts = append(parts, string(hex[b[i]&0xf]), string(hex[b[i]>>4]))
		}
	}
	return strings.Join(parts, "."), nil
}

type blResult struct {
	List    string   `json:"list"`
	Zone    string   `json:"zone"`
	IP      string   `json:"ip"`
	Status  string   `json:"status"` // clean, listed, refused, error
	Answers []string `json:"answers,omitempty"`
	Error   string   `json:"error,omitempty"`
	Delist  string   `json:"delist,omitempty"`
}

func lookupDNSBL(ctx context.Context, r Resolver, bl DNSBL, ip string) blResult {
	res := blResult{List: bl.Name, Zone: bl.Zone, IP: ip}
	rev, err := ReverseIP(ip)
	if err != nil {
		res.Status, res.Error = "error", err.Error()
		return res
	}
	addrs, err := r.LookupHost(ctx, rev+"."+bl.Zone+".")
	if err != nil {
		var de *net.DNSError
		if errors.As(err, &de) && de.IsNotFound {
			res.Status = "clean"
			return res
		}
		res.Status, res.Error = "error", err.Error()
		return res
	}
	res.Answers = addrs
	res.Status = "listed"
	for _, a := range addrs {
		if bl.Spamhaus && strings.HasPrefix(a, "127.255.255.") {
			res.Status = "refused"
			res.Error = "Spamhaus refused the query (" + a + "): the resolver is public or over its limit"
			return res
		}
		if !strings.HasPrefix(a, "127.") {
			res.Status, res.Error = "error", "unexpected answer "+a
			return res
		}
	}
	res.Delist = bl.Delist
	return res
}

func (s *Service) checkBlacklists(ctx context.Context, e *CheckEnv, ips []ipInfo, ipErrs []string) Check {
	if !hasV4(ips) {
		return noIP(ipErrs)
	}
	r, resolverName := e.DNSBL, "custom"
	if r == nil {
		r, resolverName = s.dnsblResolver(ctx)
	}
	var mu sync.Mutex
	var results []blResult
	var wg sync.WaitGroup
	for _, ip := range ips {
		for _, bl := range Blacklists {
			if ip.Family == "ipv6" && !bl.IPv6 {
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				res := lookupDNSBL(ctx, r, bl, ip.IP)
				mu.Lock()
				results = append(results, res)
				mu.Unlock()
			}()
		}
	}
	wg.Wait()
	sort.Slice(results, func(i, j int) bool {
		if results[i].IP != results[j].IP {
			return results[i].IP < results[j].IP
		}
		return results[i].Zone < results[j].Zone
	})
	required := map[string]bool{}
	for _, bl := range Blacklists {
		required[bl.Zone] = bl.Required
	}
	var listed, unverified, warn []string
	for _, res := range results {
		switch res.Status {
		case "listed":
			listed = append(listed, res.IP+" on "+res.List)
		case "refused", "error":
			msg := res.List + " (" + res.IP + "): " + res.Error
			if required[res.Zone] {
				unverified = append(unverified, msg)
			} else {
				warn = append(warn, msg)
			}
		}
	}
	c := Check{OK: len(listed) == 0 && len(unverified) == 0, Data: map[string]any{"resolver": resolverName, "results": results}}
	switch {
	case len(listed) > 0:
		c.Detail = "listed: " + strings.Join(listed, "; ")
		c.Hint = "Request delisting via the link per list; mail stays off while the IP is on Spamhaus."
	case len(unverified) > 0:
		c.Detail = "could not verify: " + strings.Join(unverified, "; ")
		c.Hint = "Spamhaus refuses public resolvers: queries must go through the own resolver (panel-unbound) " +
			"or MAIL_DNSBL_RESOLVER."
	default:
		c.Detail = "not listed on " + strconv.Itoa(len(Blacklists)) + " blacklists"
	}
	if len(warn) > 0 {
		c.Detail += "; not checked: " + strings.Join(warn, "; ")
	}
	return c
}

// dnsblResolver: MAIL_DNSBL_RESOLVER ("system", host:poort), of leeg = panel-unbound op zijn container-IP, met
// de systeemresolver als terugval.
func (s *Service) dnsblResolver(ctx context.Context) (Resolver, string) {
	switch v := s.cfg.DNSBLResolver; {
	case v == "system":
		return net.DefaultResolver, "system"
	case v != "":
		addr := v
		if _, _, err := net.SplitHostPort(v); err != nil {
			addr = net.JoinHostPort(v, "53")
		}
		return resolverAt(addr), addr
	}
	if s.dock != nil {
		if c, err := s.container(ctx, s.cfg.Unbound); err == nil {
			if ips, err := s.dock.IPs(ctx, c.ID); err == nil {
				names := make([]string, 0, len(ips))
				for n := range ips {
					names = append(names, n)
				}
				sort.Strings(names)
				for _, n := range names {
					if ips[n] != "" {
						addr := net.JoinHostPort(ips[n], "53")
						return resolverAt(addr), s.cfg.Unbound + " (" + addr + ")"
					}
				}
			}
		}
	}
	return net.DefaultResolver, "system"
}

func resolverAt(addr string) *net.Resolver {
	d := &net.Dialer{Timeout: 3 * time.Second}
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return d.DialContext(ctx, network, addr)
	}}
}

// --- certificate ---

func checkCertificate(ctx context.Context, e *CheckEnv, tlsAddr, host string) Check {
	conn, err := e.Dial(ctx, "tcp", tlsAddr)
	if err != nil {
		return Check{Detail: "cannot reach Caddy on " + tlsAddr + ": " + err.Error(), Hint: caddyHint(host)}
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	tc := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}) //nolint:gosec // we controleren hieronder zelf
	if err := tc.HandshakeContext(ctx); err != nil {
		return Check{Detail: "TLS handshake for " + host + " failed: " + err.Error(), Hint: caddyHint(host)}
	}
	certs := tc.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return Check{Detail: "no certificate presented", Hint: caddyHint(host)}
	}
	leaf := certs[0]
	inter := x509.NewCertPool()
	for _, c := range certs[1:] {
		inter.AddCert(c)
	}
	now := e.Now()
	days := int(leaf.NotAfter.Sub(now).Hours() / 24)
	data := map[string]any{"subject": leaf.Subject.CommonName, "dns_names": leaf.DNSNames, "issuer": leaf.Issuer.CommonName,
		"not_before": leaf.NotBefore.UTC(), "not_after": leaf.NotAfter.UTC(), "days_left": days}
	_, verr := leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: e.TLSRoots, Intermediates: inter, CurrentTime: now})
	data["valid"] = verr == nil
	if verr != nil {
		return Check{Detail: "certificate for " + host + " is not valid: " + verr.Error(), Hint: caddyHint(host), Data: data}
	}
	c := Check{OK: true, Data: data, Detail: fmt.Sprintf("valid certificate for %s from %s, %d days left", host, leaf.Issuer.CommonName, days)}
	if days < 14 {
		c.Detail += " (renewal overdue)"
		c.Hint = caddyHint(host)
	}
	return c
}

func caddyHint(host string) string {
	return "Caddy gets the certificate for " + host + ": check that its A record points here, that port 80 is " +
		"reachable and look at the Caddy log (docker logs panel-caddy)."
}

// --- ports_free ---

type conflict struct {
	Port      int    `json:"port"`
	Addr      string `json:"addr,omitempty"`
	PID       int    `json:"pid,omitempty"`
	Process   string `json:"process,omitempty"`
	Container string `json:"container,omitempty"`
}

func (s *Service) checkPortsFree(ctx context.Context, e *CheckEnv) Check {
	ports := e.InboundPorts
	ls, err := e.Listeners(ports)
	if err != nil {
		return Check{Detail: "cannot read listening sockets: " + err.Error()}
	}
	mailIDs := map[string]bool{}
	mailPorts := map[int]bool{}
	var conflicts []conflict
	if s.dock != nil {
		all, err := s.dock.Containers(ctx, nil)
		if err != nil {
			return Check{Detail: "cannot list containers: " + err.Error()}
		}
		for _, c := range all {
			own := s.isMail(c.Labels) && (c.Name == s.cfg.Postfix || c.Name == s.cfg.Dovecot)
			if own {
				mailIDs[c.ID] = true
			}
			if c.State != "running" {
				continue
			}
			for _, p := range c.Ports {
				if p.Proto != "tcp" || !slices.Contains(ports, p.HostPort) {
					continue
				}
				if own {
					mailPorts[p.HostPort] = true
				} else {
					conflicts = append(conflicts, conflict{Port: p.HostPort, Addr: p.HostIP, Container: c.Name})
				}
			}
		}
	}
	for _, l := range ls {
		if l.Process == "docker-proxy" {
			if mailPorts[l.Port] || slices.ContainsFunc(conflicts, func(c conflict) bool { return c.Port == l.Port }) {
				continue // de container is al ingedeeld
			}
		}
		inMail := false
		if l.PID > 0 {
			for id := range mailIDs {
				if e.InContainer(l.PID, id) {
					inMail = true
				}
			}
		}
		if !inMail {
			conflicts = append(conflicts, conflict{Port: l.Port, Addr: l.Addr, PID: l.PID, Process: l.Process})
		}
	}
	sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].Port < conflicts[j].Port })
	c := Check{OK: len(conflicts) == 0, Data: map[string]any{"conflicts": conflicts}}
	if c.OK {
		c.Detail = "ports " + joinInts(ports) + " are free (or used by the mail stack)"
		return c
	}
	var parts []string
	for _, x := range conflicts {
		who := x.Container
		switch {
		case who != "":
			who = "container " + who
		case x.Process != "":
			who = fmt.Sprintf("%s (pid %d)", x.Process, x.PID)
		case x.PID > 0:
			who = fmt.Sprintf("pid %d", x.PID)
		default:
			who = "unknown process"
		}
		parts = append(parts, fmt.Sprintf("port %d: %s", x.Port, who))
	}
	c.Detail = "in use: " + strings.Join(parts, "; ")
	c.Hint = "Stop the other mail server (e.g. a local Postfix/Exim: systemctl disable --now postfix) or move it to other ports."
	return c
}

// --- clock ---

func checkClock(ctx context.Context, e *CheckEnv, server string) Check {
	off, err := e.NTP(ctx, server)
	if err != nil {
		return Check{Detail: "NTP query to " + server + " failed: " + err.Error(), Hint: "Allow outgoing UDP 123 or check time sync (timedatectl)."}
	}
	abs := off
	if abs < 0 {
		abs = -abs
	}
	c := Check{OK: abs <= 2*time.Second, Data: map[string]any{"offset_ms": off.Milliseconds(), "server": server}}
	c.Detail = fmt.Sprintf("clock offset %s against %s", off.Round(time.Millisecond), server)
	if !c.OK {
		c.Hint = "Enable time synchronisation (timedatectl set-ntp true, chrony or systemd-timesyncd)."
	}
	return c
}

// --- disk ---

func diskFree(path string) (uint64, uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	return st.Blocks * uint64(st.Bsize), st.Bavail * uint64(st.Bsize), nil
}

func checkDisk(e *CheckEnv, path string) Check {
	total, free, err := e.DiskFree(path)
	if err != nil || total == 0 {
		return Check{Detail: fmt.Sprintf("cannot read free space of %s: %v", path, err)}
	}
	pct := float64(free) * 100 / float64(total)
	c := Check{OK: pct >= 10, Data: map[string]any{"path": path, "total_bytes": total, "free_bytes": free, "free_pct": math.Round(pct*10) / 10}}
	c.Detail = fmt.Sprintf("%.1f%% free on %s (%d GiB of %d GiB)", pct, path, free>>30, total>>30)
	if !c.OK {
		c.Hint = "Less than 10% free: free up space or enlarge the disk before mail fills it."
	}
	return c
}
