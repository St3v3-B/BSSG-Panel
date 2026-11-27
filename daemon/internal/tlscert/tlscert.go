// Package tlscert regelt het certificaat van het node-domein voor nodes zonder Caddy op 80/443
// (supports_domains = false): de daemon luistert zelf met TLS op DAEMON_TLS_PORT en haalt een Let's
// Encrypt-certificaat met de DNS-01-challenge. De TXT-records zet het panel (POST /api/remote/acme/dns,
// via Cloudflare), dus er verlaat geen DNS-token het panel.
package tlscert

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
)

// LetsEncryptProduction is de standaardmap.
const LetsEncryptProduction = "https://acme-v02.api.letsencrypt.org/directory"

// DNSSolver zet en verwijdert het TXT-record `_acme-challenge.<domein>`.
type DNSSolver interface {
	Present(ctx context.Context, value string) error
	Cleanup(ctx context.Context, value string) error
}

// Manager bewaart en vernieuwt het certificaat.
type Manager struct {
	Domain    string
	Email     string
	Directory string // ACME-directory-URL (standaard Let's Encrypt productie; tests/staging: ACME_DIRECTORY)
	Dir       string // opslag: account.key, cert.pem, key.pem
	DNS       DNSSolver
	Log       *slog.Logger
	// PropagationWait: wachttijd tussen het zetten van het TXT-record en het melden aan de CA (standaard 25 s).
	PropagationWait time.Duration
	// RenewBefore: vernieuwen als het certificaat korter geldig is (standaard 30 dagen).
	RenewBefore time.Duration

	mu   sync.RWMutex
	cert *tls.Certificate
}

func (m *Manager) log() *slog.Logger {
	if m.Log != nil {
		return m.Log
	}
	return slog.Default()
}

// GetCertificate voor tls.Config.
func (m *Manager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.cert == nil {
		return nil, errors.New("certificate not available yet")
	}
	return m.cert, nil
}

// Load leest een bewaard certificaat; false als er geen (geldig) is.
func (m *Manager) Load() bool {
	c, err := tls.LoadX509KeyPair(filepath.Join(m.Dir, "cert.pem"), filepath.Join(m.Dir, "key.pem"))
	if err != nil {
		return false
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil || time.Now().After(leaf.NotAfter) || leaf.VerifyHostname(m.Domain) != nil {
		return false
	}
	c.Leaf = leaf
	m.mu.Lock()
	m.cert = &c
	m.mu.Unlock()
	return true
}

// NeedsRenewal: geen certificaat of bijna verlopen.
func (m *Manager) NeedsRenewal(now time.Time) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.cert == nil || m.cert.Leaf == nil {
		return true
	}
	rb := m.RenewBefore
	if rb == 0 {
		rb = 30 * 24 * time.Hour
	}
	return now.Add(rb).After(m.cert.Leaf.NotAfter)
}

// Run laadt het bewaarde certificaat en haalt/vernieuwt het zo nodig, tot ctx eindigt. Bij een fout na 5 min opnieuw.
func (m *Manager) Run(ctx context.Context) {
	m.Load()
	for {
		wait := 12 * time.Hour
		if m.NeedsRenewal(time.Now()) {
			if err := m.Obtain(ctx); err != nil {
				m.log().Warn("certificate for the node domain failed", "domain", m.Domain, "err", err)
				wait = 5 * time.Minute
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func (m *Manager) accountKey() (*ecdsa.PrivateKey, error) {
	p := filepath.Join(m.Dir, "account.key")
	if b, err := os.ReadFile(p); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			return x509.ParseECPrivateKey(blk.Bytes)
		}
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalECPrivateKey(k)
	return k, writeFile(p, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Obtain doet één bestelling (DNS-01) en bewaart het resultaat.
func (m *Manager) Obtain(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	ak, err := m.accountKey()
	if err != nil {
		return err
	}
	dir := m.Directory
	if dir == "" {
		dir = LetsEncryptProduction
	}
	cl := &acme.Client{Key: ak, DirectoryURL: dir, UserAgent: "panel-daemon"}
	acct := &acme.Account{}
	if m.Email != "" {
		acct.Contact = []string{"mailto:" + m.Email}
	}
	if _, err := cl.Register(ctx, acct, acme.AcceptTOS); err != nil && !errors.Is(err, acme.ErrAccountAlreadyExists) {
		return fmt.Errorf("acme account: %w", err)
	}
	order, err := cl.AuthorizeOrder(ctx, acme.DomainIDs(m.Domain))
	if err != nil {
		return fmt.Errorf("acme order: %w", err)
	}
	for _, u := range order.AuthzURLs {
		if err := m.solve(ctx, cl, u); err != nil {
			return err
		}
	}
	if order, err = cl.WaitOrder(ctx, order.URI); err != nil {
		return fmt.Errorf("acme order: %w", err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{DNSNames: []string{m.Domain}}, key)
	if err != nil {
		return err
	}
	der, _, err := cl.CreateOrderCert(ctx, order.FinalizeURL, csr, true)
	if err != nil {
		return fmt.Errorf("acme finalize: %w", err)
	}
	var chain []byte
	for _, d := range der {
		chain = append(chain, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: d})...)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	if err := writeFile(filepath.Join(m.Dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb})); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(m.Dir, "cert.pem"), chain); err != nil {
		return err
	}
	if !m.Load() {
		return errors.New("issued certificate does not load")
	}
	m.log().Info("certificate for the node domain installed", "domain", m.Domain)
	return nil
}

func (m *Manager) solve(ctx context.Context, cl *acme.Client, authzURL string) error {
	az, err := cl.GetAuthorization(ctx, authzURL)
	if err != nil {
		return err
	}
	if az.Status == acme.StatusValid {
		return nil
	}
	var ch *acme.Challenge
	for _, c := range az.Challenges {
		if c.Type == "dns-01" {
			ch = c
		}
	}
	if ch == nil {
		return errors.New("CA offers no dns-01 challenge")
	}
	val, err := cl.DNS01ChallengeRecord(ch.Token)
	if err != nil {
		return err
	}
	if err := m.DNS.Present(ctx, val); err != nil {
		return fmt.Errorf("dns present: %w", err)
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = m.DNS.Cleanup(cctx, val)
	}()
	wait := m.PropagationWait
	if wait == 0 {
		wait = 25 * time.Second
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(wait):
	}
	if _, err := cl.Accept(ctx, ch); err != nil {
		return err
	}
	if _, err := cl.WaitAuthorization(ctx, az.URI); err != nil {
		return fmt.Errorf("dns-01 validation: %w", err)
	}
	return nil
}
