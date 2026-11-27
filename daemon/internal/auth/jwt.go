// Package auth controleert node-tokens en browser-JWT's.
package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"panel/daemon/internal/panel"
)

// TokenEqual vergelijkt twee tokens in constante tijd (ook bij verschillende lengte).
func TokenEqual(a, b string) bool {
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1 && len(a) > 0
}

// Claims van een browser-JWT (zie openapi.yaml, Authenticatie).
type Claims struct {
	jwt.RegisteredClaims
	ServerUUID  string   `json:"server_uuid"`
	Permissions []string `json:"permissions"`
}

// Has geeft aan of de claims een recht bevatten.
func (c *Claims) Has(p string) bool { return slices.Contains(c.Permissions, p) }

// KeyFetcher haalt de JWKS op.
type KeyFetcher func(ctx context.Context) ([]panel.JWK, error)

// MaxLifetime is de langste geldigheid die de daemon accepteert (contract: 10 min).
const MaxLifetime = 10*time.Minute + 30*time.Second

// Verifier controleert JWT's met de sleutels van het panel. Sleutels worden gecachet
// en opnieuw opgehaald bij een onbekende kid (hooguit eens per RefreshEvery).
type Verifier struct {
	Fetch        KeyFetcher
	Audience     string
	RefreshEvery time.Duration
	Now          func() time.Time

	mu        sync.Mutex
	keys      map[string]ed25519.PublicKey
	lastFetch time.Time
}

// NewVerifier maakt een Verifier.
func NewVerifier(fetch KeyFetcher, audience string) *Verifier {
	return &Verifier{Fetch: fetch, Audience: audience, RefreshEvery: 5 * time.Second, Now: time.Now}
}

func (v *Verifier) refresh(ctx context.Context) error {
	jwks, err := v.Fetch(ctx)
	if err != nil {
		return err
	}
	keys := map[string]ed25519.PublicKey{}
	for _, k := range jwks {
		if k.Kty != "OKP" || k.Crv != "Ed25519" {
			continue
		}
		raw, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		keys[k.Kid] = ed25519.PublicKey(raw)
	}
	v.keys = keys
	v.lastFetch = v.Now()
	return nil
}

func (v *Verifier) key(ctx context.Context, kid string) (ed25519.PublicKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	lookup := func() (ed25519.PublicKey, bool) {
		if kid == "" && len(v.keys) == 1 {
			for _, k := range v.keys {
				return k, true
			}
		}
		k, ok := v.keys[kid]
		return k, ok
	}
	if k, ok := lookup(); ok {
		return k, nil
	}
	if v.keys == nil || v.Now().Sub(v.lastFetch) >= v.RefreshEvery {
		if err := v.refresh(ctx); err != nil {
			return nil, fmt.Errorf("jwt-key ophalen: %w", err)
		}
		if k, ok := lookup(); ok {
			return k, nil
		}
	}
	return nil, fmt.Errorf("unknown kid %q", kid)
}

// Verify controleert handtekening, alg, aud, exp en de maximale levensduur.
func (v *Verifier) Verify(ctx context.Context, token string) (*Claims, error) {
	claims := &Claims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithAudience(v.Audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(5*time.Second),
		jwt.WithTimeFunc(v.Now),
	)
	_, err := parser.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return v.key(ctx, kid)
	})
	if err != nil {
		return nil, err
	}
	if claims.ServerUUID == "" {
		return nil, errors.New("server_uuid is missing")
	}
	if claims.ExpiresAt.Sub(v.Now()) > MaxLifetime {
		return nil, errors.New("token is te lang geldig")
	}
	return claims, nil
}
