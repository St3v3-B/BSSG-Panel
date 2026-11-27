package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// checkTLS opent een TLS-verbinding naar Caddy met SNI = host en controleert
// de keten die Caddy serveert:
//   - geldig (systeem-CA's, ExtraRoots of Caddy's eigen CA bij tls internal) → active
//   - geen of ongeldig certificaat terwijl de route bestaat → issuing
//   - Caddy niet bereikbaar op TLSAddr → pending, met reden in Error
//
// Lukt dat niet, dan bepaalt diagnose (status.go) of het dns_wrong of failed is.
func (c *Caddy) checkTLS(ctx context.Context, host string) (SSLStatus, string) {
	sni := host
	if strings.HasPrefix(host, "*.") {
		sni = "panel-ssl-check." + host[2:]
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", c.tlsAddr)
	if err != nil {
		return SSLPending, fmt.Sprintf("Caddy not reachable at %s: %v", c.tlsAddr, err)
	}
	defer raw.Close()
	conn := tls.Client(raw, &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: true, // we verifiëren hieronder zelf, met meerdere root-sets
		NextProtos:         []string{"http/1.1"},
	})
	if err := conn.HandshakeContext(ctx); err != nil {
		return SSLIssuing, "no certificate yet: " + err.Error()
	}
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return SSLIssuing, "geen certificaat"
	}
	err = verifyChain(certs, sni, nil)
	if err != nil && c.extra != nil {
		err = verifyChain(certs, sni, c.extra)
	}
	var ua x509.UnknownAuthorityError
	if err != nil && errors.As(err, &ua) {
		if pool := c.caddyLocalRoots(ctx); pool != nil {
			err = verifyChain(certs, sni, pool)
		}
	}
	if err != nil {
		return SSLIssuing, "certificate not valid yet: " + err.Error()
	}
	return SSLActive, ""
}

func verifyChain(certs []*x509.Certificate, name string, roots *x509.CertPool) error {
	inter := x509.NewCertPool()
	for _, c := range certs[1:] {
		inter.AddCert(c)
	}
	_, err := certs[0].Verify(x509.VerifyOptions{DNSName: name, Roots: roots, Intermediates: inter})
	return err
}

// caddyLocalRoots haalt de root van Caddy's interne CA (tls internal / local_certs)
// via GET /pki/ca/local (niet gecachet: de CA kan wisselen als /data leeg begint).
// nil als die er niet is.
func (c *Caddy) caddyLocalRoots(ctx context.Context) *x509.CertPool {
	resp, b, err := c.do(ctx, http.MethodGet, "/pki/ca/local", nil, nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil
	}
	var ca struct {
		Root string `json:"root_certificate"`
	}
	if json.Unmarshal(b, &ca) != nil {
		return nil
	}
	blk, _ := pem.Decode([]byte(ca.Root))
	if blk == nil {
		return nil
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return nil
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return pool
}
