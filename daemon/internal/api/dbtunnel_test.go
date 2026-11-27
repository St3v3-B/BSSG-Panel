package api

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"panel/daemon/internal/dbadmin"
)

// fakeDB is een DBAdmin met Dial naar een vaste (test)listener; het tunnelverzoek kan het doel niet beïnvloeden.
type fakeDB struct {
	addr  string
	fail  bool
	dials atomic.Int32
}

func (f *fakeDB) Status(context.Context) error                                { return nil }
func (f *fakeDB) Create(context.Context, string, string, string) error        { return nil }
func (f *fakeDB) SetPassword(context.Context, string, string) error           { return nil }
func (f *fakeDB) Drop(context.Context, string, string) error                  { return nil }
func (f *fakeDB) Dump(context.Context, string, io.Writer) error               { return nil }
func (f *fakeDB) Import(context.Context, string, io.Reader) error             { return nil }
func (f *fakeDB) Exists(context.Context, string) (bool, error)                { return true, nil }
func (f *fakeDB) SyncPmaUser(context.Context, string, string, []string) error { return nil }
func (f *fakeDB) Dial(ctx context.Context) (net.Conn, error) {
	f.dials.Add(1)
	if f.fail {
		return nil, dbadmin.ErrUnavailable
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", f.addr)
}

// greeter bootst MariaDB na: stuurt eerst een begroeting, echoot daarna alles met een voorvoegsel.
func greeter(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var open atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			open.Add(1)
			go func() {
				defer open.Add(-1)
				defer c.Close()
				io.WriteString(c, "HELLO-MARIADB\n")
				r := bufio.NewReader(c)
				for {
					l, err := r.ReadString('\n')
					if err != nil {
						return
					}
					io.WriteString(c, "echo:"+l)
				}
			}()
		}
	}()
	return ln.Addr().String(), &open
}

func tunnelServer(t *testing.T, db DBAdmin) (*httptest.Server, *API) {
	t.Helper()
	a := New(Options{NodeToken: "tok"}, nil, nil, nil, func(context.Context) SystemInfo { return SystemInfo{} }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if db != nil {
		a.SetDBAdmin(db, "panel-mariadb")
	}
	s := httptest.NewServer(a.Handler())
	t.Cleanup(s.Close)
	return s, a
}

// openTunnel doet het upgradeverzoek op een ruwe verbinding; geeft de status en (bij 101) de verbinding.
func openTunnel(t *testing.T, s *httptest.Server, path string, hdr map[string]string) (int, net.Conn, *bufio.Reader) {
	t.Helper()
	c, err := net.Dial("tcp", strings.TrimPrefix(s.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	req := "GET " + path + " HTTP/1.1\r\nHost: node1.test\r\n"
	for k, v := range hdr {
		req += k + ": " + v + "\r\n"
	}
	io.WriteString(c, req+"\r\n")
	r := bufio.NewReader(c)
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	res, err := http.ReadResponse(r, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Time{})
	if res.StatusCode != http.StatusSwitchingProtocols {
		res.Body.Close()
		c.Close()
		return res.StatusCode, nil, nil
	}
	t.Cleanup(func() { c.Close() })
	return res.StatusCode, c, r
}

var upgradeHdr = map[string]string{"Authorization": "Bearer tok", "Connection": "Upgrade", "Upgrade": TunnelProtocol}

func TestDBTunnelAuthAndValidation(t *testing.T) {
	addr, _ := greeter(t)
	db := &fakeDB{addr: addr}
	s, _ := tunnelServer(t, db)
	// Zonder of met verkeerd token: 401, en er wordt niets gebeld.
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", map[string]string{"Connection": "Upgrade", "Upgrade": TunnelProtocol}); code != 401 {
		t.Fatal("zonder token", code)
	}
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", map[string]string{"Authorization": "Bearer fout", "Connection": "Upgrade", "Upgrade": TunnelProtocol}); code != 401 {
		t.Fatal("verkeerd token", code)
	}
	// Zonder Upgrade-header: 426.
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", map[string]string{"Authorization": "Bearer tok"}); code != 426 {
		t.Fatal("zonder upgrade", code)
	}
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", map[string]string{"Authorization": "Bearer tok", "Connection": "Upgrade", "Upgrade": "websocket"}); code != 426 {
		t.Fatal("ander protocol", code)
	}
	if db.dials.Load() != 0 {
		t.Fatal("gebeld zonder geldige aanvraag")
	}
	// Geen andere methode of pad.
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", map[string]string{"Authorization": "Bearer tok"}); code == 101 {
		t.Fatal("101 zonder upgrade")
	}
}

func TestDBTunnelPipesToLocalMariaDBOnly(t *testing.T) {
	addr, open := greeter(t)
	db := &fakeDB{addr: addr}
	s, _ := tunnelServer(t, db)
	// Query-parameters of headers kunnen het doel niet veranderen: het doel komt alleen uit Dial.
	other, _ := net.Listen("tcp", "127.0.0.1:0")
	defer other.Close()
	hdr := map[string]string{"X-Target": other.Addr().String()}
	for k, v := range upgradeHdr {
		hdr[k] = v
	}
	code, c, r := openTunnel(t, s, "/api/db/tunnel?host=evil.example&port=22&target="+other.Addr().String(), hdr)
	if code != 101 {
		t.Fatal("tunnel", code)
	}
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if l, err := r.ReadString('\n'); err != nil || l != "HELLO-MARIADB\n" {
		t.Fatalf("begroeting: %q %v", l, err)
	}
	io.WriteString(c, "SELECT 1\n")
	if l, err := r.ReadString('\n'); err != nil || l != "echo:SELECT 1\n" {
		t.Fatalf("echo: %q %v", l, err)
	}
	// Groot blok in één keer heen en terug.
	big := strings.Repeat("x", 200_000) + "\n"
	go io.WriteString(c, big)
	if l, err := r.ReadString('\n'); err != nil || l != "echo:"+big {
		t.Fatalf("groot blok: %d %v", len(l), err)
	}
	// Client sluit: de upstream-verbinding gaat ook dicht.
	c.Close()
	deadline := time.Now().Add(3 * time.Second)
	for open.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("upstream blijft open na sluiten client")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDBTunnelUnavailable(t *testing.T) {
	// Geen MariaDB op deze node: 503.
	s, _ := tunnelServer(t, nil)
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", upgradeHdr); code != 503 {
		t.Fatal("zonder dbadmin", code)
	}
	// MariaDB-container weg of gestopt: 503 vóór de upgrade.
	s2, _ := tunnelServer(t, &fakeDB{fail: true})
	if code, _, _ := openTunnel(t, s2, "/api/db/tunnel", upgradeHdr); code != 503 {
		t.Fatal("dial faalt", code)
	}
}

func TestDBTunnelLimitAndIdle(t *testing.T) {
	addr, open := greeter(t)
	s, a := tunnelServer(t, &fakeDB{addr: addr})
	// Limiet: bij maxTunnels open tunnels geeft de volgende 503.
	a.tunnels.Store(maxTunnels)
	if code, _, _ := openTunnel(t, s, "/api/db/tunnel", upgradeHdr); code != 503 {
		t.Fatal("limiet", code)
	}
	a.tunnels.Store(0)
	code, c, r := openTunnel(t, s, "/api/db/tunnel", upgradeHdr)
	if code != 101 {
		t.Fatal(code)
	}
	r.ReadString('\n')
	if a.tunnels.Load() != 1 {
		t.Fatal("teller", a.tunnels.Load())
	}
	c.Close()
	deadline := time.Now().Add(3 * time.Second)
	for a.tunnels.Load() != 0 || open.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("teller of upstream niet vrijgegeven", a.tunnels.Load(), open.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestPipeTunnelIdleTimeout(t *testing.T) {
	a1, b1 := net.Pipe()
	a2, b2 := net.Pipe()
	done := make(chan struct{})
	go func() { pipeTunnel(b1, nil, a2, 100*time.Millisecond); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("idle timeout sluit de tunnel niet")
	}
	if _, err := a1.Write([]byte("x")); err == nil {
		t.Fatal("client nog open")
	}
	if _, err := b2.Write([]byte("x")); err == nil {
		t.Fatal("upstream nog open")
	}
}
