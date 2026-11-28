package proxy

// Client voor de (onofficiële) REST API van Nginx Proxy Manager (jc21/nginx-proxy-manager).
// Geverifieerd tegen de schema's in backend/schema van NPM (2.12 t/m 2.17):
//
//	GET    /api                         → {status, setup, version:{major,minor,revision}} (zonder token)
//	POST   /api/tokens                  {identity, secret} → {token, expires} of {requires_2fa, challenge_token}
//	GET    /api/nginx/proxy-hosts       (Bearer) → []ProxyHost
//	POST   /api/nginx/proxy-hosts       → ProxyHost (201)
//	PUT    /api/nginx/proxy-hosts/{id}  → ProxyHost
//	DELETE /api/nginx/proxy-hosts/{id}
//	GET    /api/nginx/certificates      → []Certificate
//	POST   /api/nginx/certificates      {provider: letsencrypt, domain_names, meta} → Certificate (synchroon: LE-aanvraag)
//	DELETE /api/nginx/certificates/{id}
//
// Fouten: {"error": {"code": <status>, "message": "..."}}. Tokens verlopen standaard na 1 dag; de client
// logt opnieuw in zodra het token binnen 10 minuten verloopt of NPM 401 antwoordt.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NPMError is een foutantwoord van NPM.
type NPMError struct {
	Status  int
	Message string
}

func (e *NPMError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("NPM answered %d", e.Status)
	}
	return fmt.Sprintf("NPM answered %d: %s", e.Status, e.Message)
}

// ErrNPMLogin: NPM weigert de inloggegevens (of het account heeft 2FA).
var ErrNPMLogin = errors.New("npm: login failed")

// flexBool accepteert true/false en 0/1 (oudere NPM-versies geven getallen).
type flexBool bool

func (b *flexBool) UnmarshalJSON(p []byte) error {
	s := strings.TrimSpace(string(p))
	switch s {
	case "true", "1":
		*b = true
	case "false", "0", "null", `""`:
		*b = false
	default:
		return fmt.Errorf("npm: not a boolean: %s", s)
	}
	return nil
}

// flexInt accepteert een getal of een string met een getal ("new" en dergelijke = 0).
type flexInt int

func (n *flexInt) UnmarshalJSON(p []byte) error {
	s := strings.Trim(strings.TrimSpace(string(p)), `"`)
	v, err := strconv.Atoi(s)
	if err != nil {
		*n = 0
		return nil
	}
	*n = flexInt(v)
	return nil
}

// npmProxyHost is het deel van een NPM-proxy-host dat we lezen.
type npmProxyHost struct {
	ID             flexInt        `json:"id"`
	DomainNames    []string       `json:"domain_names"`
	ForwardScheme  string         `json:"forward_scheme"`
	ForwardHost    string         `json:"forward_host"`
	ForwardPort    flexInt        `json:"forward_port"`
	CertificateID  flexInt        `json:"certificate_id"`
	SSLForced      flexBool       `json:"ssl_forced"`
	HTTP2          flexBool       `json:"http2_support"`
	Websocket      flexBool       `json:"allow_websocket_upgrade"`
	BlockExploits  flexBool       `json:"block_exploits"`
	Enabled        flexBool       `json:"enabled"`
	AdvancedConfig string         `json:"advanced_config"`
	Meta           map[string]any `json:"meta"`
}

// npmProxyHostBody is wat we bij POST/PUT sturen (alleen velden uit het NPM-schema).
type npmProxyHostBody struct {
	DomainNames    []string       `json:"domain_names"`
	ForwardScheme  string         `json:"forward_scheme"`
	ForwardHost    string         `json:"forward_host"`
	ForwardPort    int            `json:"forward_port"`
	CertificateID  int            `json:"certificate_id"`
	SSLForced      bool           `json:"ssl_forced"`
	HTTP2          bool           `json:"http2_support"`
	HSTS           bool           `json:"hsts_enabled"`
	Websocket      bool           `json:"allow_websocket_upgrade"`
	BlockExploits  bool           `json:"block_exploits"`
	Caching        bool           `json:"caching_enabled"`
	AccessListID   int            `json:"access_list_id"`
	AdvancedConfig string         `json:"advanced_config"`
	Meta           map[string]any `json:"meta"`
	Locations      []any          `json:"locations"`
}

// npmCertificate is het deel van een NPM-certificaat dat we lezen.
type npmCertificate struct {
	ID          flexInt        `json:"id"`
	Provider    string         `json:"provider"`
	NiceName    string         `json:"nice_name"`
	DomainNames []string       `json:"domain_names"`
	ExpiresOn   string         `json:"expires_on"`
	Meta        map[string]any `json:"meta"`
}

// expires parseert expires_on ("2025-01-07 04:30:17" of RFC 3339). Nul als onbekend.
func (c npmCertificate) expires() time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, c.ExpiresOn); err == nil {
			return t
		}
	}
	return time.Time{}
}

// NPMInfo is het antwoord van GET /api.
type NPMInfo struct {
	Version string // "2.17.1"
	Major   int
	Minor   int
	Setup   bool // false = NPM wacht nog op de eerste gebruiker
}

// npmClient praat met één NPM-instantie. Veilig voor gelijktijdig gebruik.
type npmClient struct {
	base     string // zonder slash aan het eind, bv. http://127.0.0.1:81
	identity string
	secret   string
	hc       *http.Client
	now      func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
	logins  int // aantal geslaagde logins (tests)
}

func newNPMClient(base, identity, secret string, hc *http.Client) (*npmClient, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(base), "/"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("npm: invalid URL %q (expected http://host:port)", base)
	}
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &npmClient{base: u.Scheme + "://" + u.Host, identity: identity, secret: secret, hc: hc, now: time.Now}, nil
}

// raw doet één request; out mag nil zijn.
func (c *npmClient) raw(ctx context.Context, method, path, token string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		msg := e.Error.Message
		if msg == "" && len(b) > 0 && len(b) < 300 && !bytes.Contains(b, []byte("<")) {
			msg = strings.TrimSpace(string(b))
		}
		return &NPMError{Status: resp.StatusCode, Message: shorten(msg)}
	}
	if out != nil && len(b) > 0 {
		if err := json.Unmarshal(b, out); err != nil {
			return fmt.Errorf("npm: unexpected answer on %s %s: %w", method, path, err)
		}
	}
	return nil
}

// Info: GET /api (zonder token).
func (c *npmClient) Info(ctx context.Context) (NPMInfo, error) {
	var r struct {
		Status  string `json:"status"`
		Setup   *bool  `json:"setup"`
		Version struct {
			Major, Minor, Revision int
		} `json:"version"`
	}
	if err := c.raw(ctx, http.MethodGet, "/api/", "", nil, &r); err != nil {
		return NPMInfo{}, err
	}
	if r.Status != "OK" {
		return NPMInfo{}, fmt.Errorf("npm: %s/api does not look like Nginx Proxy Manager", c.base)
	}
	info := NPMInfo{Major: r.Version.Major, Minor: r.Version.Minor, Setup: r.Setup == nil || *r.Setup}
	info.Version = fmt.Sprintf("%d.%d.%d", r.Version.Major, r.Version.Minor, r.Version.Revision)
	return info, nil
}

// login haalt een nieuw token (c.mu vastgehouden).
func (c *npmClient) loginLocked(ctx context.Context) error {
	var r struct {
		Token     string `json:"token"`
		Expires   string `json:"expires"`
		Requires2 bool   `json:"requires_2fa"`
	}
	err := c.raw(ctx, http.MethodPost, "/api/tokens", "", map[string]string{"identity": c.identity, "secret": c.secret}, &r)
	var ne *NPMError
	if errors.As(err, &ne) && (ne.Status == http.StatusUnauthorized || ne.Status == http.StatusForbidden || ne.Status == http.StatusBadRequest) {
		return fmt.Errorf("%w: %s", ErrNPMLogin, ne.Message)
	}
	if err != nil {
		return err
	}
	if r.Requires2 {
		return fmt.Errorf("%w: the NPM account has two-factor authentication; use a separate account without 2FA for the panel", ErrNPMLogin)
	}
	if r.Token == "" {
		return fmt.Errorf("%w: no token in the answer", ErrNPMLogin)
	}
	c.token = r.Token
	c.expires = c.now().Add(23 * time.Hour)
	if t, err := time.Parse(time.RFC3339Nano, r.Expires); err == nil {
		c.expires = t
	}
	c.logins++
	return nil
}

// tokenFor geeft een geldig token; force = altijd opnieuw inloggen.
func (c *npmClient) tokenFor(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if force || c.token == "" || c.now().Add(10*time.Minute).After(c.expires) {
		if err := c.loginLocked(ctx); err != nil {
			c.token = ""
			return "", err
		}
	}
	return c.token, nil
}

// Login controleert de inloggegevens (nieuw token).
func (c *npmClient) Login(ctx context.Context) error {
	_, err := c.tokenFor(ctx, true)
	return err
}

// do: met token; bij 401 één keer opnieuw inloggen.
func (c *npmClient) do(ctx context.Context, method, path string, body, out any) error {
	tok, err := c.tokenFor(ctx, false)
	if err != nil {
		return err
	}
	err = c.raw(ctx, method, path, tok, body, out)
	var ne *NPMError
	if errors.As(err, &ne) && ne.Status == http.StatusUnauthorized {
		if tok, err = c.tokenFor(ctx, true); err != nil {
			return err
		}
		err = c.raw(ctx, method, path, tok, body, out)
	}
	return err
}

func (c *npmClient) ProxyHosts(ctx context.Context) ([]npmProxyHost, error) {
	var out []npmProxyHost
	return out, c.do(ctx, http.MethodGet, "/api/nginx/proxy-hosts", nil, &out)
}

func (c *npmClient) CreateProxyHost(ctx context.Context, b npmProxyHostBody) (npmProxyHost, error) {
	var out npmProxyHost
	return out, c.do(ctx, http.MethodPost, "/api/nginx/proxy-hosts", b, &out)
}

func (c *npmClient) UpdateProxyHost(ctx context.Context, id int, b npmProxyHostBody) (npmProxyHost, error) {
	var out npmProxyHost
	return out, c.do(ctx, http.MethodPut, "/api/nginx/proxy-hosts/"+strconv.Itoa(id), b, &out)
}

func (c *npmClient) DeleteProxyHost(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodDelete, "/api/nginx/proxy-hosts/"+strconv.Itoa(id), nil, nil)
}

func (c *npmClient) Certificates(ctx context.Context) ([]npmCertificate, error) {
	var out []npmCertificate
	return out, c.do(ctx, http.MethodGet, "/api/nginx/certificates", nil, &out)
}

// npmCertRequest: een Let's Encrypt-certificaat voor domains (HTTP-01, of DNS-01 via Cloudflare als cfToken gezet is).
type npmCertRequest struct {
	Domains []string
	CFToken string // leeg = HTTP-01
	// Legacy: NPM < 2.13 wil letsencrypt_email en letsencrypt_agree in meta.
	Legacy bool
	Email  string
}

func (c *npmClient) CreateCertificate(ctx context.Context, r npmCertRequest) (npmCertificate, error) {
	meta := map[string]any{"dns_challenge": r.CFToken != ""}
	if r.CFToken != "" {
		meta["dns_provider"] = "cloudflare"
		meta["dns_provider_credentials"] = "dns_cloudflare_api_token = " + r.CFToken
		meta["propagation_seconds"] = 30
	}
	if r.Legacy {
		meta["letsencrypt_email"] = r.Email
		meta["letsencrypt_agree"] = true
	}
	body := map[string]any{"provider": "letsencrypt", "domain_names": r.Domains, "meta": meta}
	var out npmCertificate
	return out, c.do(ctx, http.MethodPost, "/api/nginx/certificates", body, &out)
}

func (c *npmClient) DeleteCertificate(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodDelete, "/api/nginx/certificates/"+strconv.Itoa(id), nil, nil)
}

// npmErrState geeft de algemene toestand bij een fout: login_failed of unreachable (of error).
func npmErrState(err error) string {
	var ne *NPMError
	var oe *net.OpError
	switch {
	case errors.Is(err, ErrNPMLogin):
		return NPMStateLoginFailed
	case errors.As(err, &oe), errors.Is(err, context.DeadlineExceeded):
		return NPMStateUnreachable
	case errors.As(err, &ne):
		if ne.Status == http.StatusBadGateway || ne.Status == http.StatusServiceUnavailable || ne.Status == http.StatusGatewayTimeout {
			return NPMStateUnreachable
		}
		return NPMStateError
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return NPMStateUnreachable
	}
	return NPMStateError
}
