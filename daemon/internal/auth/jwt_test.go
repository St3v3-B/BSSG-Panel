package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"panel/daemon/internal/panel"
	"panel/daemon/internal/testpanel"
)

const srv = "0b7c2d1e-1111-4222-8333-444455556666"

func newVerifier(t *testing.T) (*Verifier, *testpanel.Panel) {
	p := testpanel.New("tok", "node1.test")
	t.Cleanup(p.Close)
	c := panel.New(p.URL, "tok", nil)
	v := NewVerifier(c.JWKS, "node1.test")
	v.RefreshEvery = 0
	return v, p
}

func TestTokenEqual(t *testing.T) {
	if !TokenEqual("abc", "abc") || TokenEqual("abc", "abd") || TokenEqual("abc", "abcd") || TokenEqual("", "") {
		t.Fatal("TokenEqual")
	}
}

func TestVerifyOK(t *testing.T) {
	v, p := newVerifier(t)
	c, err := v.Verify(context.Background(), p.Sign(testpanel.TokenOpts{Server: srv, Permissions: []string{"console.read"}}))
	if err != nil {
		t.Fatal(err)
	}
	if c.ServerUUID != srv || !c.Has("console.read") || c.Has("power") || c.Subject != "42" {
		t.Fatalf("%+v", c)
	}
	// Gecachet: tweede verificatie haalt de sleutel niet opnieuw op.
	_, _ = v.Verify(context.Background(), p.Sign(testpanel.TokenOpts{Server: srv}))
	if p.KeyFetchs != 1 {
		t.Fatalf("key fetches = %d", p.KeyFetchs)
	}
}

func TestVerifyRefreshOnUnknownKid(t *testing.T) {
	v, p := newVerifier(t)
	if _, err := v.Verify(context.Background(), p.Sign(testpanel.TokenOpts{Server: srv})); err != nil {
		t.Fatal(err)
	}
	p.Rotate("k2")
	if _, err := v.Verify(context.Background(), p.Sign(testpanel.TokenOpts{Server: srv})); err != nil {
		t.Fatal(err)
	}
	if p.KeyFetchs != 2 {
		t.Fatalf("key fetches = %d", p.KeyFetchs)
	}
}

func TestVerifyRejects(t *testing.T) {
	v, p := newVerifier(t)
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	cases := map[string]string{
		"verkeerde aud":     p.Sign(testpanel.TokenOpts{Server: srv, Audience: "node2.test"}),
		"verlopen":          p.Sign(testpanel.TokenOpts{Server: srv, TTL: -time.Minute}),
		"te lang geldig":    p.Sign(testpanel.TokenOpts{Server: srv, TTL: time.Hour}),
		"andere sleutel":    p.Sign(testpanel.TokenOpts{Server: srv, Key: otherKey}),
		"geen server_uuid":  p.Sign(testpanel.TokenOpts{}),
		"onzin":             "a.b.c",
		"alg none":          noneToken(),
		"HS256 met pub-key": hsToken(p.Pub),
	}
	for name, tok := range cases {
		if _, err := v.Verify(context.Background(), tok); err == nil {
			t.Errorf("%s: geaccepteerd", name)
		}
	}
}

func noneToken() string {
	t := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{"aud": "node1.test", "server_uuid": srv, "exp": time.Now().Add(time.Minute).Unix()})
	s, _ := t.SignedString(jwt.UnsafeAllowNoneSignatureType)
	return s
}

func hsToken(pub ed25519.PublicKey) string {
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"aud": "node1.test", "server_uuid": srv, "exp": time.Now().Add(time.Minute).Unix()})
	t.Header["kid"] = "k1"
	s, _ := t.SignedString([]byte(pub))
	return s
}

func TestVerifyPanelDown(t *testing.T) {
	v := NewVerifier(func(context.Context) ([]panel.JWK, error) { return nil, context.DeadlineExceeded }, "node1.test")
	p := testpanel.New("x", "node1.test")
	defer p.Close()
	_, err := v.Verify(context.Background(), p.Sign(testpanel.TokenOpts{Server: srv}))
	if err == nil || !strings.Contains(err.Error(), "jwt-key") {
		t.Fatal(err)
	}
}
