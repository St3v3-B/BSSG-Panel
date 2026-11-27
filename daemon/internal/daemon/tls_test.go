package daemon

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
)

// Met DAEMON_TLS_PORT serveert de daemon zelf https voor het node-domein (opgeslagen certificaat).
func TestTLSListener(t *testing.T) {
	data := t.TempDir()
	tlsDir := filepath.Join(data, "state", "tls")
	_ = os.MkdirAll(tlsDir, 0o700)
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "node1.test"}, DNSNames: []string{"node1.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(60 * 24 * time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	kb, _ := x509.MarshalECPrivateKey(k)
	_ = os.WriteFile(filepath.Join(tlsDir, "cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(filepath.Join(tlsDir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	h := newHarnessWith(t, engine.NewFake(), nil, nil, data, nil, "", func(c *config.Config, _ *Deps) { c.TLSPort = port })
	_ = h
	pool := x509.NewCertPool()
	leaf, _ := x509.ParseCertificate(der)
	pool.AddCert(leaf)
	cl := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "node1.test"}}, Timeout: 5 * time.Second}
	req, _ := http.NewRequest("GET", "https://127.0.0.1:"+strconv.Itoa(port)+"/api/system", nil)
	req.Header.Set("Authorization", "Bearer "+nodeToken)
	resp, err := cl.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode, string(b))
	}
}
