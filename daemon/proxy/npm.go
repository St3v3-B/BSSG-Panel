package proxy

// NPM is de Router voor een node achter Nginx Proxy Manager (HTTP_MODE=npm).
//
// NPM bezit dan 80/443 en de certificaten. Onze Caddy draait daarachter zonder TLS (deploy/caddy/Caddyfile.npm)
// en routeert zoals altijd op Host naar de containers; NPM stuurt elk domein dat het panel op deze node beheert
// naar Caddy (ForwardHost:ForwardPort). NPM wikkelt de gewone Caddy-Router in:
//
//   - SetRoute/RemoveRoute/Sync gaan meteen naar Caddy (zonder DNSChallenge: Caddy doet geen ACME), en zetten
//     de gewenste set voor NPM. Een achtergrondlus (Run) maakt de proxy hosts in NPM gelijk aan die set plus
//     de vaste hosts (node-domein, panel-domein op de lokale node) en vraagt certificaten aan.
//   - Alleen proxy hosts met de marker "# managed-by-panel <instance>" in advanced_config zijn van ons. Een
//     domein dat in NPM al bij een andere host hoort is een conflict: nooit overschrijven, alleen melden.
//   - Status leest de certificaatstatus uit NPM (geen TLS-dial naar CADDY_TLS_ADDR).
//   - Healthy delegeert naar Caddy (herstart → Sync); de toestand van NPM zelf staat in Status/NPMStatus.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Toestanden van de koppeling met NPM.
const (
	NPMStateUnconfigured = "unconfigured" // geen instellingen van het panel
	NPMStateOK           = "ok"
	NPMStateLoginFailed  = "login_failed"
	NPMStateUnreachable  = "unreachable"
	NPMStateError        = "error"
)

// NPM-SSL-modi.
const (
	NPMSSLHTTP       = "http"       // Let's Encrypt HTTP-01 via NPM
	NPMSSLCloudflare = "cloudflare" // Let's Encrypt DNS-01 via Cloudflare (token)
)

// NPMSettings komen van het panel (GET /api/remote/npm).
type NPMSettings struct {
	URL      string `json:"url"`
	Email    string `json:"email"`
	Password string `json:"password"`
	// ForwardHost/ForwardPort: waar NPM onze Caddy bereikt. Leeg/0 = NPMOptions.DefaultForward.
	ForwardHost string `json:"forward_host"`
	ForwardPort int    `json:"forward_port"`
	SSL         string `json:"ssl"` // NPMSSLHTTP (standaard) of NPMSSLCloudflare
	// CloudflareToken voor DNS-01 (SSL=cloudflare, en wildcards).
	CloudflareToken string `json:"cloudflare_token"`
	ForceSSL        bool   `json:"force_ssl"`
	// LetsEncryptEmail: alleen voor NPM < 2.13 (daarna gebruikt NPM het e-mailadres van het account).
	LetsEncryptEmail string `json:"letsencrypt_email"`
	// FixedHosts: altijd naar Caddy (node-domein; panel-domein op de lokale node).
	FixedHosts []string `json:"fixed_hosts"`
}

// NPMHostStatus is de toestand van één domein in NPM.
type NPMHostStatus struct {
	Host      string    `json:"host"`
	ProxyHost int       `json:"proxy_host_id,omitempty"`
	SSL       SSLStatus `json:"ssl"`
	Error     string    `json:"error,omitempty"`
	Conflict  bool      `json:"conflict,omitempty"`
	Expires   time.Time `json:"expires,omitzero"`
}

// NPMStatus is de toestand van de koppeling, voor de daemon-API en het panel.
type NPMStatus struct {
	State      string          `json:"state"`
	Error      string          `json:"error,omitempty"`
	Version    string          `json:"version,omitempty"`
	ProxyHosts int             `json:"proxy_hosts"`   // alle proxy hosts in NPM (zichtbaar voor het account)
	Managed    int             `json:"managed_hosts"` // waarvan van het panel
	Conflicts  []string        `json:"conflicts"`
	Hosts      []NPMHostStatus `json:"hosts"`
	CheckedAt  time.Time       `json:"checked_at,omitzero"`
}

// NPMOptions voor NewNPM.
type NPMOptions struct {
	// Instance (PANEL_INSTANCE) staat in de marker; alleen hosts met dezelfde instance zijn van ons.
	Instance string
	// DefaultForward (NPM_CADDY_ADDR van de node, host:poort) als het panel geen forward host/poort zet.
	DefaultForward string
	HTTPClient     *http.Client
	// CertRetry: wachttijd na een mislukte certificaataanvraag (Let's Encrypt-limieten). Standaard 1 uur.
	CertRetry time.Duration
	// CertTimeout per aanvraag (NPM wacht synchroon op certbot). Standaard 5 minuten.
	CertTimeout time.Duration
	// Interval van de achtergrondlus. Standaard 1 minuut.
	Interval time.Duration
	// OnStatus wordt aangeroepen na elke ronde waarin de status veranderde.
	OnStatus func(NPMStatus)
	Now      func() time.Time
}

// MarkerPrefix staat op de eerste regel van advanced_config van elke proxy host van het panel.
const MarkerPrefix = "# managed-by-panel "

var markerRe = regexp.MustCompile(`(?m)^# managed-by-panel (\S+)(?: cert=(\d+))?\s*$`)

// npmAdvanced: nginx-opties voor alles wat we doorsturen (streams, websockets, uploads).
const npmAdvanced = `# Do not edit: the hosting panel manages this proxy host and overwrites changes.
proxy_read_timeout 1h;
proxy_send_timeout 1h;
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 0;`

type npmHostState struct {
	proxyID   int
	certID    int
	expires   time.Time
	conflict  string
	err       string // fout bij aanmaken/bijwerken van de host
	certErr   string
	certTried time.Time
	certKey   string // instellingen bij de laatste poging; anders meteen opnieuw
}

// NPM implementeert Router en HealthChecker.
type NPM struct {
	inner Router
	opt   NPMOptions

	mu       sync.Mutex
	settings *NPMSettings
	client   *npmClient
	clientOf string // URL|email|password van client
	desired  map[string]Route
	hosts    map[string]*npmHostState
	status   NPMStatus
	info     NPMInfo

	recMu sync.Mutex
	kick  chan struct{}
}

var (
	_ Router        = (*NPM)(nil)
	_ HealthChecker = (*NPM)(nil)
)

// NewNPM wikkelt de Caddy-Router in.
func NewNPM(inner Router, opt NPMOptions) *NPM {
	if opt.CertRetry == 0 {
		opt.CertRetry = time.Hour
	}
	if opt.CertTimeout == 0 {
		opt.CertTimeout = 5 * time.Minute
	}
	if opt.Interval == 0 {
		opt.Interval = time.Minute
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Instance == "" {
		opt.Instance = "main"
	}
	return &NPM{
		inner: inner, opt: opt,
		desired: map[string]Route{}, hosts: map[string]*npmHostState{},
		status: NPMStatus{State: NPMStateUnconfigured, Conflicts: []string{}, Hosts: []NPMHostStatus{}},
		kick:   make(chan struct{}, 1),
	}
}

// Configure zet de instellingen van het panel (nil = geen NPM-koppeling: alleen Caddy). Start een ronde.
func (n *NPM) Configure(s *NPMSettings) {
	n.mu.Lock()
	if s == nil {
		n.settings = nil
		n.client = nil
		n.clientOf = ""
	} else {
		c := *s
		c.FixedHosts = append([]string(nil), s.FixedHosts...)
		n.settings = &c
		key := c.URL + "\x00" + c.Email + "\x00" + c.Password
		if n.client == nil || key != n.clientOf {
			cl, err := newNPMClient(c.URL, c.Email, c.Password, n.opt.HTTPClient)
			if err != nil {
				n.client = nil
				n.status = NPMStatus{State: NPMStateError, Error: err.Error(), Conflicts: []string{}, Hosts: []NPMHostStatus{}, CheckedAt: n.opt.Now()}
			} else {
				cl.now = n.opt.Now
				n.client = cl
			}
			n.clientOf = key
		}
	}
	n.mu.Unlock()
	n.Kick()
}

// Configured: zijn er instellingen van het panel?
func (n *NPM) Configured() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.settings != nil
}

// Kick vraagt een ronde zo snel mogelijk.
func (n *NPM) Kick() {
	select {
	case n.kick <- struct{}{}:
	default:
	}
}

// Run is de achtergrondlus: een ronde na elke Kick en elke Interval. Stopt met ctx.
func (n *NPM) Run(ctx context.Context) {
	t := time.NewTicker(n.opt.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-n.kick:
		case <-t.C:
		}
		rctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		_ = n.Reconcile(rctx)
		cancel()
	}
}

// ---------- Router ----------

// forCaddy: Caddy achter NPM doet geen ACME; DNS-challenges horen bij NPM.
func forCaddy(r Route) Route {
	r.DNSChallenge = nil
	return r
}

func (n *NPM) SetRoute(ctx context.Context, r Route) error {
	h, err := normHost(r.Host)
	if err != nil {
		return err
	}
	r.Host = h
	if err := n.inner.SetRoute(ctx, forCaddy(r)); err != nil {
		return err
	}
	n.mu.Lock()
	old, had := n.desired[h]
	n.desired[h] = r
	n.mu.Unlock()
	// Placeholder-wissels (statuswijziging van een site) veranderen niets in NPM.
	if !had || !sameNPM(old, r) {
		n.Kick()
	}
	return nil
}

func sameNPM(a, b Route) bool {
	ad, bd := "", ""
	if a.DNSChallenge != nil {
		ad = a.DNSChallenge.APIToken
	}
	if b.DNSChallenge != nil {
		bd = b.DNSChallenge.APIToken
	}
	return a.Host == b.Host && ad == bd
}

func (n *NPM) RemoveRoute(ctx context.Context, host string) error {
	h, err := normHost(host)
	if err != nil {
		return err
	}
	err = n.inner.RemoveRoute(ctx, h)
	n.mu.Lock()
	_, had := n.desired[h]
	delete(n.desired, h)
	n.mu.Unlock()
	if had {
		n.Kick()
	}
	return err
}

func (n *NPM) Sync(ctx context.Context, routes []Route) error {
	caddy := make([]Route, 0, len(routes))
	want := make(map[string]Route, len(routes))
	for _, r := range routes {
		h, err := normHost(r.Host)
		if err != nil {
			continue // Caddy meldt het hieronder
		}
		r.Host = h
		want[h] = r
		caddy = append(caddy, forCaddy(r))
	}
	err := n.inner.Sync(ctx, caddy)
	n.mu.Lock()
	n.desired = want
	n.mu.Unlock()
	n.Kick()
	return err
}

// Status: de certificaatstatus van host volgens NPM.
func (n *NPM) Status(ctx context.Context, host string) (RouteStatus, error) {
	h, err := normHost(host)
	if err != nil {
		return RouteStatus{}, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, ok := n.desired[h]; !ok {
		return RouteStatus{}, ErrNotFound
	}
	st := n.hostStatusLocked(h)
	if st.SSL != SSLActive && n.status.State != NPMStateOK && n.status.State != NPMStateUnconfigured && n.settings != nil {
		msg := "Nginx Proxy Manager: " + n.status.State
		if n.status.Error != "" {
			msg += ": " + n.status.Error
		}
		if st.Error != "" {
			msg += "; " + st.Error
		}
		st.Error = msg
	}
	return RouteStatus{Host: h, SSL: st.SSL, Error: st.Error, CheckedAt: n.status.CheckedAt}, nil
}

// Healthy: Caddy (achter NPM). Een herstart van Caddy → de daemon doet Sync.
func (n *NPM) Healthy(ctx context.Context) error {
	if hc, ok := n.inner.(HealthChecker); ok {
		return hc.Healthy(ctx)
	}
	return nil
}

// NPMStatus geeft de laatste toestand.
func (n *NPM) NPMStatus() NPMStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	s := n.status
	s.Conflicts = append([]string{}, s.Conflicts...)
	s.Hosts = append([]NPMHostStatus{}, s.Hosts...)
	return s
}

func (n *NPM) hostStatusLocked(h string) NPMHostStatus {
	out := NPMHostStatus{Host: h, SSL: SSLPending}
	if n.settings == nil {
		out.Error = "Nginx Proxy Manager is not configured for this node yet (Admin > Nodes > HTTP(S) entry)"
		return out
	}
	s := n.hosts[h]
	if s == nil {
		return out
	}
	out.ProxyHost = s.proxyID
	out.Expires = s.expires
	switch {
	case s.conflict != "":
		out.SSL, out.Error, out.Conflict = SSLFailed, s.conflict, true
	case s.err != "":
		out.SSL, out.Error = SSLPending, s.err
	case s.certID > 0 && !s.expires.IsZero() && !s.expires.After(n.opt.Now()):
		out.SSL, out.Error = SSLFailed, "the certificate in Nginx Proxy Manager has expired"
	case s.certID > 0:
		out.SSL, out.Error = SSLActive, ""
	case s.certErr != "":
		out.SSL, out.Error = classify(h, s.certErr), s.certErr
	case s.proxyID > 0:
		out.SSL = SSLIssuing
	}
	return out
}

// ---------- reconcile ----------

type npmWant struct {
	host  string
	cf    string // Cloudflare-token voor DNS-01, leeg = HTTP-01
	fixed bool
}

func (n *NPM) wanted() (*NPMSettings, *npmClient, []npmWant) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.settings == nil {
		return nil, nil, nil
	}
	s := *n.settings
	seen := map[string]bool{}
	var out []npmWant
	add := func(w npmWant) {
		if !seen[w.host] {
			seen[w.host] = true
			out = append(out, w)
		}
	}
	nodeCF := ""
	if s.SSL == NPMSSLCloudflare {
		nodeCF = s.CloudflareToken
	}
	for _, f := range s.FixedHosts {
		if h, err := normHost(f); err == nil {
			add(npmWant{host: h, cf: nodeCF, fixed: true})
		}
	}
	for h, r := range n.desired {
		w := npmWant{host: h, cf: nodeCF}
		if r.DNSChallenge != nil && r.DNSChallenge.APIToken != "" {
			w.cf = r.DNSChallenge.APIToken
		}
		if strings.HasPrefix(h, "*.") && w.cf == "" {
			w.cf = s.CloudflareToken // wildcard: alleen DNS-01
		}
		add(w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].host < out[j].host })
	return &s, n.client, out
}

func (n *NPM) forward(s *NPMSettings) (string, int) {
	host, port := s.ForwardHost, s.ForwardPort
	if dh, dp, err := net.SplitHostPort(n.opt.DefaultForward); err == nil {
		if host == "" {
			host = dh
		}
		if port == 0 {
			port, _ = strconv.Atoi(dp)
		}
	}
	if host == "" {
		host = "172.17.0.1"
	}
	if port == 0 {
		port = 8081
	}
	return host, port
}

func (n *NPM) marker(certID int) string {
	m := MarkerPrefix + n.opt.Instance
	if certID > 0 {
		m += " cert=" + strconv.Itoa(certID)
	}
	return m
}

// ours: is ph een host van deze panel-instance? Geeft ook het certificaat dat wij aanvroegen.
func (n *NPM) ours(ph npmProxyHost) (bool, int) {
	m := markerRe.FindStringSubmatch(ph.AdvancedConfig)
	if m == nil || m[1] != n.opt.Instance {
		return false, 0
	}
	id, _ := strconv.Atoi(m[2])
	return true, id
}

// IsPanelManaged: draagt advanced_config de marker van instance? (tests, diagnose)
func IsPanelManaged(advancedConfig, instance string) bool {
	m := markerRe.FindStringSubmatch(advancedConfig)
	return m != nil && m[1] == instance
}

func (n *NPM) body(s *NPMSettings, host string, certID, ownCert int) npmProxyHostBody {
	fh, fp := n.forward(s)
	return npmProxyHostBody{
		DomainNames: []string{host}, ForwardScheme: "http", ForwardHost: fh, ForwardPort: fp,
		CertificateID: certID, SSLForced: certID > 0 && s.ForceSSL, HTTP2: certID > 0,
		Websocket: true, AdvancedConfig: n.marker(ownCert) + "\n" + npmAdvanced,
		Meta: map[string]any{}, Locations: []any{},
	}
}

func sameHost(ph npmProxyHost, b npmProxyHostBody) bool {
	return len(ph.DomainNames) == 1 && strings.EqualFold(ph.DomainNames[0], b.DomainNames[0]) &&
		ph.ForwardScheme == b.ForwardScheme && ph.ForwardHost == b.ForwardHost && int(ph.ForwardPort) == b.ForwardPort &&
		int(ph.CertificateID) == b.CertificateID && bool(ph.SSLForced) == b.SSLForced && bool(ph.HTTP2) == b.HTTP2 &&
		bool(ph.Websocket) && !bool(ph.BlockExploits) && bool(ph.Enabled) &&
		strings.TrimSpace(ph.AdvancedConfig) == strings.TrimSpace(b.AdvancedConfig)
}

// covers: dekt certificaatnaam name de host h? (exact, of *.x voor één label onder x)
func covers(name, h string) bool {
	name = strings.ToLower(name)
	if name == h {
		return true
	}
	if strings.HasPrefix(name, "*.") && !strings.HasPrefix(h, "*.") {
		i := strings.IndexByte(h, '.')
		return i > 0 && h[i+1:] == name[2:]
	}
	return false
}

func (n *NPM) setStatus(st NPMStatus) {
	n.mu.Lock()
	prev := n.status
	n.status = st
	cb := n.opt.OnStatus
	n.mu.Unlock()
	if cb != nil && (prev.State != st.State || prev.Error != st.Error || prev.Managed != st.Managed || len(prev.Conflicts) != len(st.Conflicts) || prev.Version != st.Version || !sameHosts(prev.Hosts, st.Hosts)) {
		cb(n.NPMStatus())
	}
}

func sameHosts(a, b []NPMHostStatus) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Host != b[i].Host || a[i].SSL != b[i].SSL || a[i].Error != b[i].Error {
			return false
		}
	}
	return true
}

// Reconcile maakt de proxy hosts in NPM gelijk aan de gewenste set en vraagt ontbrekende certificaten aan.
// Fouten per host staan in de status; de teruggegeven fout gaat over NPM als geheel.
func (n *NPM) Reconcile(ctx context.Context) error {
	n.recMu.Lock()
	defer n.recMu.Unlock()
	s, cl, want := n.wanted()
	now := n.opt.Now()
	if s == nil {
		n.setStatus(NPMStatus{State: NPMStateUnconfigured, Conflicts: []string{}, Hosts: []NPMHostStatus{}, CheckedAt: now})
		return nil
	}
	if cl == nil {
		n.mu.Lock()
		st := n.status
		n.mu.Unlock()
		return errors.New(st.Error)
	}
	fail := func(err error) error {
		n.setStatus(NPMStatus{State: npmErrState(err), Error: shorten(err.Error()), Conflicts: []string{}, Hosts: n.hostList(want), CheckedAt: now})
		return err
	}
	info, err := cl.Info(ctx)
	if err != nil {
		return fail(err)
	}
	n.mu.Lock()
	n.info = info
	n.mu.Unlock()
	list, err := cl.ProxyHosts(ctx)
	if err != nil {
		return fail(err)
	}
	certs, err := cl.Certificates(ctx)
	if err != nil {
		return fail(err)
	}
	byDomain := map[string]npmProxyHost{}
	var mine []npmProxyHost
	for _, ph := range list {
		for _, d := range ph.DomainNames {
			byDomain[strings.ToLower(d)] = ph
		}
		if ok, _ := n.ours(ph); ok {
			mine = append(mine, ph)
		}
	}
	total := len(list)
	wantSet := map[string]bool{}
	for _, w := range want {
		wantSet[w.host] = true
	}

	// 1. Weg: eigen hosts die niet meer gewenst zijn (en het certificaat dat wij ervoor aanvroegen).
	used := map[int]int{} // certificaat → aantal hosts
	for _, ph := range list {
		if ph.CertificateID > 0 {
			used[int(ph.CertificateID)]++
		}
	}
	for _, ph := range mine {
		keep := false
		for _, d := range ph.DomainNames {
			if wantSet[strings.ToLower(d)] {
				keep = true
			}
		}
		if keep {
			continue
		}
		if err := cl.DeleteProxyHost(ctx, int(ph.ID)); err != nil {
			var ne *NPMError
			if !errors.As(err, &ne) || ne.Status != http.StatusNotFound {
				return fail(err)
			}
		}
		total--
		for _, d := range ph.DomainNames {
			delete(byDomain, strings.ToLower(d))
		}
		if _, own := n.ours(ph); own > 0 && int(ph.CertificateID) == own && used[own] <= 1 {
			_ = cl.DeleteCertificate(ctx, own) // best effort
		}
	}
	n.mu.Lock()
	for h := range n.hosts {
		if !wantSet[h] {
			delete(n.hosts, h)
		}
	}
	n.mu.Unlock()

	// 2. Aanmaken/bijwerken (zonder nieuwe certificaten: die komen in stap 3, want ze duren lang).
	var needCert []npmWant
	for _, w := range want {
		st := n.state(w.host)
		ph, exists := byDomain[w.host]
		if exists {
			if ok, _ := n.ours(ph); !ok {
				n.update(w.host, func(s *npmHostState) {
					*s = npmHostState{conflict: fmt.Sprintf("%s already exists in Nginx Proxy Manager (proxy host #%d) and is not managed by the panel; remove it there or choose another domain", w.host, ph.ID)}
				})
				continue
			}
		}
		_, own := n.ours(ph)
		certID := int(ph.CertificateID)
		if !exists {
			certID, own = 0, 0
		}
		var exp time.Time
		if certID == 0 {
			// Een bestaand geldig certificaat in NPM dat de host dekt (ook van de gebruiker; alleen gebruiken).
			for _, c := range certs {
				e := c.expires()
				if !e.IsZero() && !e.After(now.Add(24*time.Hour)) {
					continue
				}
				for _, d := range c.DomainNames {
					if covers(d, w.host) {
						certID, exp = int(c.ID), e
						break
					}
				}
				if certID > 0 {
					break
				}
			}
		} else {
			for _, c := range certs {
				if int(c.ID) == certID {
					exp = c.expires()
				}
			}
		}
		b := n.body(s, w.host, certID, own)
		var got npmProxyHost
		switch {
		case !exists:
			got, err = cl.CreateProxyHost(ctx, b)
		case !sameHost(ph, b):
			got, err = cl.UpdateProxyHost(ctx, int(ph.ID), b)
		default:
			got = ph
		}
		if err != nil {
			var ne *NPMError
			if errors.As(err, &ne) && ne.Status == http.StatusBadRequest && strings.Contains(ne.Message, "already in use") {
				n.update(w.host, func(s *npmHostState) {
					*s = npmHostState{conflict: fmt.Sprintf("%s is already used in Nginx Proxy Manager (redirection or 404 host, not managed by the panel); remove it there", w.host)}
				})
				continue
			}
			if errors.As(err, &ne) && ne.Status != http.StatusUnauthorized {
				n.update(w.host, func(s *npmHostState) { s.err, s.conflict = "Nginx Proxy Manager: "+ne.Message, "" })
				continue
			}
			return fail(err)
		}
		if !exists {
			total++
		}
		n.update(w.host, func(s *npmHostState) {
			s.proxyID, s.certID, s.expires, s.conflict, s.err = int(got.ID), certID, exp, "", ""
			if certID > 0 {
				s.certErr = ""
			}
		})
		if certID == 0 {
			key := w.cf
			if st.certKey != key || st.certTried.IsZero() || now.Sub(st.certTried) >= n.opt.CertRetry {
				needCert = append(needCert, w)
			}
		}
	}
	n.setStatus(n.summary(info, total, want, now))

	// 3. Certificaten, één voor één.
	for _, w := range needCert {
		if strings.HasPrefix(w.host, "*.") && w.cf == "" {
			n.update(w.host, func(s *npmHostState) {
				s.certErr, s.certTried, s.certKey = "a wildcard domain needs a DNS challenge: link a Cloudflare DNS provider to the domain or choose Cloudflare DNS for this node", n.opt.Now(), w.cf
			})
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, n.opt.CertTimeout)
		cert, err := cl.CreateCertificate(cctx, npmCertRequest{
			Domains: []string{w.host}, CFToken: w.cf,
			Legacy: info.Major == 2 && info.Minor < 13, Email: firstNonEmpty(s.LetsEncryptEmail, s.Email),
		})
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			msg := err.Error()
			var ne *NPMError
			if errors.As(err, &ne) {
				msg = ne.Message
			}
			if npmErrState(err) == NPMStateLoginFailed {
				return fail(err)
			}
			n.update(w.host, func(s *npmHostState) { s.certErr, s.certTried, s.certKey = shorten(msg), n.opt.Now(), w.cf })
			continue
		}
		st := n.state(w.host)
		b := n.body(s, w.host, int(cert.ID), int(cert.ID))
		if _, err := cl.UpdateProxyHost(ctx, st.proxyID, b); err != nil {
			n.update(w.host, func(s *npmHostState) {
				s.certErr, s.certTried, s.certKey = "certificate issued but attaching it failed: "+shorten(err.Error()), n.opt.Now(), w.cf
			})
			continue
		}
		n.update(w.host, func(s *npmHostState) {
			s.certID, s.expires, s.certErr, s.certTried, s.certKey = int(cert.ID), cert.expires(), "", n.opt.Now(), w.cf
		})
	}
	if len(needCert) > 0 {
		n.setStatus(n.summary(info, total, want, n.opt.Now()))
	}
	return nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func (n *NPM) state(h string) npmHostState {
	n.mu.Lock()
	defer n.mu.Unlock()
	if s := n.hosts[h]; s != nil {
		return *s
	}
	return npmHostState{}
}

func (n *NPM) update(h string, f func(*npmHostState)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	s := n.hosts[h]
	if s == nil {
		s = &npmHostState{}
		n.hosts[h] = s
	}
	f(s)
}

func (n *NPM) hostList(want []npmWant) []NPMHostStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]NPMHostStatus, 0, len(want))
	for _, w := range want {
		out = append(out, n.hostStatusLocked(w.host))
	}
	return out
}

func (n *NPM) summary(info NPMInfo, total int, want []npmWant, now time.Time) NPMStatus {
	st := NPMStatus{State: NPMStateOK, Version: info.Version, ProxyHosts: total, Conflicts: []string{}, CheckedAt: now}
	n.mu.Lock()
	for _, w := range want {
		s := n.hosts[w.host]
		if s == nil {
			continue
		}
		if s.conflict != "" {
			st.Conflicts = append(st.Conflicts, w.host)
		} else if s.proxyID > 0 {
			st.Managed++
		}
	}
	n.mu.Unlock()
	st.Hosts = n.hostList(want)
	if !info.Setup {
		st.State, st.Error = NPMStateError, "Nginx Proxy Manager has no user yet: finish its setup first"
	}
	return st
}

// NPMTestResult is het resultaat van TestNPM.
type NPMTestResult struct {
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
	Version    string `json:"version,omitempty"`
	ProxyHosts int    `json:"proxy_hosts"`
	Managed    int    `json:"managed_hosts"`
}

// TestNPM logt in bij NPM en telt de proxy hosts ("Test verbinding" in het panel). Wijzigt niets.
func TestNPM(ctx context.Context, s NPMSettings, instance string, hc *http.Client) NPMTestResult {
	cl, err := newNPMClient(s.URL, s.Email, s.Password, hc)
	if err != nil {
		return NPMTestResult{State: NPMStateError, Error: err.Error()}
	}
	info, err := cl.Info(ctx)
	if err != nil {
		return NPMTestResult{State: npmErrState(err), Error: shorten(err.Error())}
	}
	if !info.Setup {
		return NPMTestResult{State: NPMStateError, Version: info.Version, Error: "Nginx Proxy Manager has no user yet: finish its setup first"}
	}
	if err := cl.Login(ctx); err != nil {
		return NPMTestResult{State: npmErrState(err), Version: info.Version, Error: shorten(err.Error())}
	}
	list, err := cl.ProxyHosts(ctx)
	if err != nil {
		return NPMTestResult{State: npmErrState(err), Version: info.Version, Error: shorten(err.Error())}
	}
	r := NPMTestResult{State: NPMStateOK, Version: info.Version, ProxyHosts: len(list)}
	for _, ph := range list {
		if IsPanelManaged(ph.AdvancedConfig, instance) {
			r.Managed++
		}
	}
	return r
}
