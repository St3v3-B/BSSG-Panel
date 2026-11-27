package proxy

// SSL-status voorbij "nog geen certificaat": dns_wrong en failed.
//
//  1. Caddy's log (JSON, via Docker): de laatste gebeurtenis voor de hostnaam. Een
//     mislukte poging met een DNS/bereikbaarheidsfout van de CA → dns_wrong, een andere
//     fout → failed (met de foutmelding). Een geslaagde poging daarna → issuing.
//  2. Geen uitsluitsel uit het log en geen wildcard: de A/AAAA-records van de host
//     vergelijken met de IP's van deze node. Geen records of geen overlap → dns_wrong.
//
// Kanttekening: een host achter de Cloudflare-proxy (oranje wolk) wijst naar
// Cloudflare-IP's en geeft dns_wrong zolang er geen certificaat is.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// IPResolver is het deel van net.Resolver dat de DNS-controle gebruikt.
type IPResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// logWindow: hoe ver we terugkijken in Caddy's log.
const logWindow = 6 * time.Hour

func (c *Caddy) diagnose(ctx context.Context, host, prev string) (SSLStatus, string) {
	if c.logs != nil {
		if b, err := c.logs(ctx, time.Now().Add(-logWindow)); err == nil {
			if st, msg, ok := lastObtainResult(b, host); ok {
				return st, msg
			}
		}
	}
	if !strings.HasPrefix(host, "*.") {
		if msg, wrong := c.dnsMismatch(ctx, host); wrong {
			return SSLDNSWrong, msg
		}
	}
	return SSLIssuing, prev
}

var bracketHost = regexp.MustCompile(`^\[([^\]]+)\]`)

// lastObtainResult zoekt de laatste certificaatgebeurtenis voor host in Caddy's
// JSON-log. ok=false als er niets beslissends is.
func lastObtainResult(log []byte, host string) (SSLStatus, string, bool) {
	var st SSLStatus
	var msg string
	found := false
	sc := bufio.NewScanner(bytes.NewReader(log))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if !bytes.Contains(line, []byte(host)) {
			continue
		}
		var e struct {
			Level, Logger, Msg, Identifier, Error string
		}
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		id := e.Identifier
		if id == "" {
			if m := bracketHost.FindStringSubmatch(e.Error); m != nil {
				id = m[1]
			}
		}
		if !strings.EqualFold(id, host) {
			continue
		}
		switch {
		case strings.Contains(e.Msg, "certificate obtained successfully"):
			st, msg, found = SSLIssuing, "", false // geslaagd; checkTLS ziet het straks
		case e.Level == "error" && e.Error != "" && (strings.Contains(e.Msg, "could not get certificate") || strings.Contains(e.Msg, "will retry") || strings.HasPrefix(e.Logger, "tls")):
			st, msg, found = classify(host, e.Error), shorten(e.Error), true
		}
	}
	return st, msg, found
}

// Foutmeldingen van de CA die betekenen dat de HTTP/TLS-challenge deze node niet bereikt.
var dnsWrongHints = []string{
	"acme:error:dns", "NXDOMAIN", "no valid A records", "no valid AAAA records", "DNS problem",
	"acme:error:connection", "Timeout during connect", "acme:error:unauthorized", "Invalid response from",
}

func classify(host, e string) SSLStatus {
	if strings.HasPrefix(host, "*.") {
		return SSLFailed // DNS-challenge: fouten gaan over token/zone, niet over A-records
	}
	for _, h := range dnsWrongHints {
		if strings.Contains(e, h) {
			return SSLDNSWrong
		}
	}
	return SSLFailed
}

var secretish = regexp.MustCompile(`(?i)(token|key|secret|password)["=: ]+[^\s",]+`)

func shorten(s string) string {
	s = secretish.ReplaceAllString(s, "$1=[verborgen]")
	if len(s) > 400 {
		s = s[:400] + "…"
	}
	return s
}

// dnsMismatch: wijst host niet naar deze node? Geeft een uitleg.
func (c *Caddy) dnsMismatch(ctx context.Context, host string) (string, bool) {
	node := c.ownIPs(ctx)
	if len(node) == 0 {
		return "", false // onbekend: niets beweren
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := c.res.LookupIPAddr(ctx, host)
	var de *net.DNSError
	if err != nil && errors.As(err, &de) && de.IsNotFound {
		return fmt.Sprintf("%s has no A or AAAA record; point it to this server (%s)", host, ipList(node)), true
	}
	if err != nil || len(addrs) == 0 {
		return "", false
	}
	var got []net.IP
	for _, a := range addrs {
		got = append(got, a.IP)
		for _, n := range node {
			if a.IP.Equal(n) {
				return "", false
			}
		}
	}
	return fmt.Sprintf("DNS of %s points to %s, not to this server (%s)", host, ipList(got), ipList(node)), true
}

func (c *Caddy) ownIPs(ctx context.Context) []net.IP {
	if len(c.nodeIPs) > 0 {
		return c.nodeIPs
	}
	var out []net.IP
	if nd := os.Getenv("NODE_DOMAIN"); nd != "" {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if as, err := c.res.LookupIPAddr(ctx, nd); err == nil {
			for _, a := range as {
				out = append(out, a.IP)
			}
		}
	}
	if as, err := net.InterfaceAddrs(); err == nil {
		for _, a := range as {
			if n, ok := a.(*net.IPNet); ok && n.IP.IsGlobalUnicast() && !n.IP.IsPrivate() {
				out = append(out, n.IP)
			}
		}
	}
	return out
}

func ipList(ips []net.IP) string {
	s := make([]string, 0, len(ips))
	seen := map[string]bool{}
	for _, ip := range ips {
		if t := ip.String(); !seen[t] {
			seen[t] = true
			s = append(s, t)
		}
	}
	sort.Strings(s)
	return strings.Join(s, ", ")
}
