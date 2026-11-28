package dbadmin

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"time"

	"panel/daemon/internal/engine"
)

// DefaultPort is de MariaDB-poort in de container.
const DefaultPort = 3306

// Dial opent een TCP-verbinding met de MariaDB van deze node (de container `Container`, poort 3306), voor de
// databasetunnel van phpMyAdmin (GET /api/db/tunnel). Het doel ligt vast: de daemon zoekt het IP-adres van precies
// deze container op via Docker en verbindt nergens anders mee; de aanroeper kiest geen host of poort.
// De container heeft geen gepubliceerde poorten; de host bereikt hem via zijn bridge-adres.
func (a *Admin) Dial(ctx context.Context) (net.Conn, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	c, err := a.Eng.Inspect(ctx, a.Container)
	if err != nil {
		if errors.Is(err, engine.ErrNotFound) {
			return nil, ErrUnavailable
		}
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if !c.Running {
		return nil, fmt.Errorf("%w: container %s is not running", ErrUnavailable, a.Container)
	}
	port := a.Port
	if port == 0 {
		port = DefaultPort
	}
	var lastErr error = fmt.Errorf("%w: container %s has no IPv4 address", ErrUnavailable, a.Container)
	for _, ip := range containerIPs(c.Networks) {
		d := net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), strconv.Itoa(port)))
		if err == nil {
			return conn, nil
		}
		lastErr = fmt.Errorf("%w: %v", ErrUnavailable, err)
		if ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

// containerIPs: geldige IPv4-adressen, stabiel gesorteerd (eerst het netwerk panel-db, dan op naam).
// Alleen adressen van de container zelf; nooit loopback, unspecified of multicast.
func containerIPs(nets map[string]string) []netip.Addr {
	names := make([]string, 0, len(nets))
	for n := range nets {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		pi, pj := names[i] == "panel-db", names[j] == "panel-db"
		if pi != pj {
			return pi
		}
		return names[i] < names[j]
	})
	var out []netip.Addr
	seen := map[netip.Addr]bool{}
	for _, n := range names {
		ip, err := netip.ParseAddr(nets[n])
		if err != nil || !ip.Is4() || ip.IsUnspecified() || ip.IsMulticast() || seen[ip] {
			continue
		}
		if ip.IsLoopback() && !allowLoopback {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	return out
}

// allowLoopback: alleen tests (een nep-MariaDB op 127.0.0.1); Docker geeft containers nooit een loopbackadres.
var allowLoopback = false
