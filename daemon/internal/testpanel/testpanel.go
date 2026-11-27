// Package testpanel is een nep-panel (httptest) voor tests: levert de JWKS, tekent
// browser-JWT's en onthoudt de meldingen van de daemon.
package testpanel

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Call is één verzoek van de daemon.
type Call struct {
	Path string
	Body map[string]any
}

// Panel is het nep-panel.
type Panel struct {
	*httptest.Server
	Token    string
	Audience string
	Kid      string
	Priv     ed25519.PrivateKey
	Pub      ed25519.PublicKey

	mu        sync.Mutex
	calls     []Call
	KeyFetchs int
	// FailNext laat zoveel verzoeken (behalve jwt-key) met 500 falen.
	FailNext int
	sftp     map[string]SFTPUser
}

// SFTPUser is een login die /api/remote/sftp/auth accepteert.
type SFTPUser struct {
	Password    string
	Server      string
	Permissions []string
}

// AddSFTPUser registreert een SFTP-login.
func (p *Panel) AddSFTPUser(username string, u SFTPUser) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sftp == nil {
		p.sftp = map[string]SFTPUser{}
	}
	p.sftp[username] = u
}

// New start een nep-panel.
func New(token, audience string) *Panel {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	p := &Panel{Token: token, Audience: audience, Kid: "k1", Priv: priv, Pub: pub}
	p.Server = httptest.NewServer(http.HandlerFunc(p.serve))
	return p
}

// Rotate maakt een nieuwe sleutel met een nieuwe kid.
func (p *Panel) Rotate(kid string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	p.mu.Lock()
	p.Kid, p.Priv, p.Pub = kid, priv, pub
	p.mu.Unlock()
}

func (p *Panel) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+p.Token {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}
	if r.URL.Path == "/api/remote/jwt-key" {
		p.mu.Lock()
		p.KeyFetchs++
		jwk := map[string]string{"kty": "OKP", "crv": "Ed25519", "x": base64.RawURLEncoding.EncodeToString(p.Pub), "kid": p.Kid, "alg": "EdDSA"}
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{jwk}})
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if r.URL.Path == "/api/remote/sftp/auth" {
		p.mu.Lock()
		name, _ := body["username"].(string)
		pw, _ := body["password"].(string)
		u, ok := p.sftp[name]
		p.calls = append(p.calls, Call{Path: r.URL.Path, Body: body})
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if !ok || u.Password != pw {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"forbidden"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"server_uuid": u.Server, "user_id": "7", "permissions": u.Permissions})
		return
	}
	p.mu.Lock()
	if p.FailNext > 0 {
		p.FailNext--
		p.mu.Unlock()
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	p.calls = append(p.calls, Call{Path: r.URL.Path, Body: body})
	p.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// Calls geeft de verzoeken met een pad dat begint met prefix.
func (p *Panel) Calls(prefix string) []Call {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []Call
	for _, c := range p.calls {
		if strings.HasPrefix(c.Path, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// Statuses geeft de gemelde statussen van een server, in volgorde.
func (p *Panel) Statuses(uuid string) []string {
	var out []string
	for _, c := range p.Calls("/api/remote/servers/" + uuid + "/status") {
		out = append(out, c.Body["state"].(string))
	}
	return out
}

// TokenOpts voor Sign.
type TokenOpts struct {
	Server      string
	Subject     string
	Permissions []string
	TTL         time.Duration
	Audience    string
	Kid         string
	Key         ed25519.PrivateKey
	Path        string // claim "path" (downloadtoken)
	Directory   string // claim "directory" (uploadtoken)
	Archive     any    // claim "archive" (archief-downloadtoken)
}

// Sign maakt een browser-JWT.
func (p *Panel) Sign(o TokenOpts) string {
	p.mu.Lock()
	kid, key := p.Kid, p.Priv
	p.mu.Unlock()
	if o.Kid != "" {
		kid = o.Kid
	}
	if o.Key != nil {
		key = o.Key
	}
	if o.TTL == 0 {
		o.TTL = 10 * time.Minute
	}
	if o.Audience == "" {
		o.Audience = p.Audience
	}
	if o.Subject == "" {
		o.Subject = "42"
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":         p.URL,
		"aud":         o.Audience,
		"sub":         o.Subject,
		"server_uuid": o.Server,
		"permissions": o.Permissions,
		"jti":         base64.RawURLEncoding.EncodeToString([]byte(now.String())),
		"iat":         now.Unix(),
		"exp":         now.Add(o.TTL).Unix(),
	}
	if o.Path != "" {
		claims["path"] = o.Path
	}
	if o.Directory != "" {
		claims["directory"] = o.Directory
	}
	if o.Archive != nil {
		claims["archive"] = o.Archive
	}
	t := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	t.Header["kid"] = kid
	s, err := t.SignedString(key)
	if err != nil {
		panic(err)
	}
	return s
}
