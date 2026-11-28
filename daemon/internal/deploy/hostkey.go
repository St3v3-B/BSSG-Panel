package deploy

import (
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// HostKey is GitHostKey uit openapi.yaml.
type HostKey struct {
	Type          string `json:"type"`
	Fingerprint   string `json:"fingerprint"`
	KnownHostLine string `json:"known_hosts_line"`
}

var errGotKey = errors.New("host key captured")

// ErrUnreachable: er antwoordde geen SSH-server.
var ErrUnreachable = errors.New("no SSH server reachable")

// ValidHost controleert een hostnaam of IP-adres voor een host-key-scan.
func ValidHost(h string) bool {
	return h != "" && !strings.HasPrefix(h, "-") && (hostRe.MatchString(h) || net.ParseIP(h) != nil)
}

// ScanHostKeys haalt per sleuteltype de hostsleutel op (zonder in te loggen).
func ScanHostKeys(ctx context.Context, host string, port int) ([]HostKey, error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	var out []HostKey
	seen := map[string]bool{}
	for _, algo := range []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoRSASHA512} {
		var got ssh.PublicKey
		cfg := &ssh.ClientConfig{
			User:              "git",
			HostKeyAlgorithms: []string{algo},
			HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
				got = k
				return errGotKey
			},
			Timeout: 10 * time.Second,
		}
		d := net.Dialer{Timeout: 10 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, ErrUnreachable
		}
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		_, _, _, _ = ssh.NewClientConn(conn, addr, cfg)
		conn.Close()
		if got == nil {
			continue // dit type biedt de server niet aan
		}
		fp := ssh.FingerprintSHA256(got)
		if seen[fp] {
			continue
		}
		seen[fp] = true
		out = append(out, HostKey{Type: got.Type(), Fingerprint: fp, KnownHostLine: knownhosts.Line([]string{knownhosts.Normalize(addr)}, got)})
	}
	if len(out) == 0 {
		return nil, ErrUnreachable
	}
	return out, nil
}
