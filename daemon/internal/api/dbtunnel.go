package api

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// TunnelProtocol is de waarde van de Upgrade-header voor GET /api/db/tunnel.
const TunnelProtocol = "panel-mariadb"

const (
	// maxTunnels begrenst het aantal gelijktijdige tunnels (phpMyAdmin opent per verzoek één verbinding).
	maxTunnels = 64
	// tunnelIdle: zonder verkeer in beide richtingen gaat de tunnel dicht.
	tunnelIdle = 15 * time.Minute
)

// TunnelDialer opent de verbinding met de lokale MariaDB (dbadmin.Admin.Dial).
type TunnelDialer interface {
	Dial(ctx context.Context) (net.Conn, error)
}

// dbTunnel: GET /api/db/tunnel met `Connection: Upgrade` + `Upgrade: panel-mariadb` (node-token verplicht, via
// protect). Na 101 Switching Protocols is de verbinding een ruwe TCP-stroom naar de MariaDB van deze node. Het
// doel ligt vast (de container MARIADB_CONTAINER, poort 3306); het verzoek kan geen host of poort kiezen.
// Zo hoeft MariaDB nooit een poort naar buiten te openen: het panel praat via de bestaande daemon-HTTPS.
func (a *API) dbTunnel(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	d, ok := a.dbadmin.(TunnelDialer)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, "db_unavailable", "tunnel not supported")
		return
	}
	if !headerHas(r.Header, "Connection", "upgrade") || !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), TunnelProtocol) {
		w.Header().Set("Upgrade", TunnelProtocol)
		writeErr(w, http.StatusUpgradeRequired, "upgrade_required", "Upgrade: "+TunnelProtocol+" required")
		return
	}
	if a.tunnels.Add(1) > maxTunnels {
		a.tunnels.Add(-1)
		writeErr(w, http.StatusServiceUnavailable, "too_many_tunnels", "too many open database tunnels")
		return
	}
	released := false
	release := func() {
		if !released {
			released = true
			a.tunnels.Add(-1)
		}
	}
	defer release()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	upstream, err := d.Dial(ctx)
	cancel()
	if err != nil {
		a.log.Warn("db tunnel: dial", "err", err)
		dbErr(w, err)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		writeErr(w, http.StatusInternalServerError, "internal", "hijack not supported")
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	_ = conn.SetDeadline(time.Time{}) // eventuele deadlines van de http-server gelden niet meer
	if _, err := io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: "+TunnelProtocol+"\r\n\r\n"); err != nil {
		conn.Close()
		upstream.Close()
		return
	}
	pipeTunnel(conn, brw.Reader, upstream, tunnelIdle)
}

func headerHas(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, p := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(p), token) {
				return true
			}
		}
	}
	return false
}

// pipeTunnel kopieert in beide richtingen tot een kant sluit of `idle` lang niets gebeurt; daarna gaan beide dicht.
func pipeTunnel(client net.Conn, clientBuf *bufio.Reader, upstream net.Conn, idle time.Duration) {
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	done := make(chan struct{})
	var once sync.Once
	closeAll := func() {
		once.Do(func() {
			close(done)
			client.Close()
			upstream.Close()
		})
	}
	cp := func(dst io.Writer, src io.Reader) {
		defer closeAll()
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				last.Store(time.Now().UnixNano())
				if _, werr := dst.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	var src io.Reader = client
	if clientBuf != nil && clientBuf.Buffered() > 0 {
		src = io.MultiReader(io.LimitReader(clientBuf, int64(clientBuf.Buffered())), client)
	}
	go cp(upstream, src)
	go cp(client, upstream)
	tick := idle / 10
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			if time.Since(time.Unix(0, last.Load())) > idle {
				closeAll()
				return
			}
		}
	}
}
