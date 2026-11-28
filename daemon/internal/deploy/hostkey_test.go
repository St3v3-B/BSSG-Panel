package deploy

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"net"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestScanHostKeys(t *testing.T) {
	_, edPriv, _ := ed25519.GenerateKey(rand.Reader)
	rsaPriv, _ := rsa.GenerateKey(rand.Reader, 2048)
	cfg := &ssh.ServerConfig{NoClientAuth: false, PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { return nil, ssh.ErrNoAuth }}
	var fps []string
	for _, k := range []any{edPriv, rsaPriv} {
		s, err := ssh.NewSignerFromKey(k)
		if err != nil {
			t.Fatal(err)
		}
		cfg.AddHostKey(s)
		fps = append(fps, ssh.FingerprintSHA256(s.PublicKey()))
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _, _, _ = ssh.NewServerConn(c, cfg); c.Close() }()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	keys, err := ScanHostKeys(context.Background(), "127.0.0.1", port)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys[0].Type != "ssh-ed25519" || keys[0].Fingerprint != fps[0] || keys[1].Fingerprint != fps[1] {
		t.Fatalf("keys %+v, want %v", keys, fps)
	}
	if !strings.HasPrefix(keys[0].KnownHostLine, "[127.0.0.1]:") || !strings.Contains(keys[0].KnownHostLine, " ssh-ed25519 ") {
		t.Fatalf("known_hosts line %q", keys[0].KnownHostLine)
	}
	if _, err := ScanHostKeys(context.Background(), "127.0.0.1", 1); err == nil {
		t.Fatal("closed port should fail")
	}
	if ValidHost("-oProxyCommand") || ValidHost("a b") || !ValidHost("github.com") || !ValidHost("::1") {
		t.Fatal("ValidHost")
	}
}
