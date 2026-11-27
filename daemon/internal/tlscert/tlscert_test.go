package tlscert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeCert(t *testing.T, dir, name string, notAfter time.Time) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name}, NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(k)
	_ = os.WriteFile(filepath.Join(dir, "cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
}

func TestLoadServeAndRenewal(t *testing.T) {
	dir := t.TempDir()
	m := &Manager{Domain: "node2.test", Dir: dir}
	if m.Load() || !m.NeedsRenewal(time.Now()) {
		t.Fatal("zonder certificaat")
	}
	if _, err := m.GetCertificate(nil); err == nil {
		t.Fatal("verwacht fout zonder cert")
	}
	writeCert(t, dir, "node2.test", time.Now().Add(90*24*time.Hour))
	if !m.Load() || m.NeedsRenewal(time.Now()) {
		t.Fatal("geldig cert wordt niet vernieuwd")
	}
	if !m.NeedsRenewal(time.Now().Add(70 * 24 * time.Hour)) {
		t.Fatal("binnen 30 dagen vernieuwen")
	}
	// Een TLS-listener serveert het certificaat.
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{GetCertificate: m.GetCertificate})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			_ = c.(*tls.Conn).Handshake()
			c.Close()
		}
	}()
	c, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{InsecureSkipVerify: true, ServerName: "node2.test"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if got := c.ConnectionState().PeerCertificates[0].DNSNames; len(got) != 1 || got[0] != "node2.test" {
		t.Fatal(got)
	}
}

func TestLoadRejectsWrongDomainAndExpired(t *testing.T) {
	dir := t.TempDir()
	writeCert(t, dir, "other.test", time.Now().Add(time.Hour))
	if (&Manager{Domain: "node2.test", Dir: dir}).Load() {
		t.Fatal("verkeerd domein")
	}
	writeCert(t, dir, "node2.test", time.Now().Add(-time.Minute))
	if (&Manager{Domain: "node2.test", Dir: dir}).Load() {
		t.Fatal("verlopen")
	}
}
