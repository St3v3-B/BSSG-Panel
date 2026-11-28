// Package relay is de HTTP(S)-relay tussen nodes.
//
// Een node zonder eigen poort 80/443 (de client, "B") laat zijn HTTP(S)-verkeer lopen via een
// andere node (de edge, "A"). B houdt een uitgaande websocket naar https://<A>/api/relay/tunnel open;
// daarover loopt yamux. A's Caddy termineert TLS voor de domeinen van B (certificaten via HTTP-01 op A,
// of DNS-01 als de route een DNS-challenge heeft) en levert ze af op de relay-socket van A's daemon
// (Edge.ServeHTTP). Die stuurt elk verzoek als HTTP door een yamux-stream naar B. B beantwoordt
// verzoeken voor zijn eigen NODE_DOMAIN met zijn daemon-API en de rest via zijn eigen Caddy
// (zonder TLS, op een lokale socket), die de sites routeert zoals altijd.
//
// Beveiliging:
//   - A stuurt alleen hostnamen door die het panel aan B heeft toegewezen (Edge.SetClients); de rest
//     krijgt 421. Caddy op A heeft ook alleen routes voor die hostnamen.
//   - B bewijst zich met HMAC-SHA256 over (edge, node-id, tijd, nonce) met het gedeelde geheim dat
//     het panel per paar uitgeeft; A bewijst zich terug met een HMAC over de nonce. B gebruikt de
//     verbinding pas als dat bewijs klopt, en controleert daarnaast het TLS-certificaat van A.
//     Zo accepteert B alleen tunnelverkeer van de door het panel aangewezen A.
//   - Niet-HTTP-verkeer (gamepoorten, SFTP) gaat nooit via de relay.
package relay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
)

// TunnelPath is het daemon-pad waarop A tunnels accepteert.
const TunnelPath = "/api/relay/tunnel"

// Headers van de tunnel-handshake.
const (
	HdrNode  = "X-Relay-Node"
	HdrTime  = "X-Relay-Time"
	HdrNonce = "X-Relay-Nonce"
	HdrSig   = "X-Relay-Signature"
	HdrProof = "X-Relay-Proof"
)

// MaxSkew is de toegestane klokafwijking van X-Relay-Time.
const MaxSkew = 2 * time.Minute

// Config is het antwoord van GET /api/remote/relay (panel-remote.yaml).
type Config struct {
	// Edge: deze node laat zijn HTTP(S) lopen via een andere node (nil = eigen poorten).
	Edge *EdgeConfig `json:"edge"`
	// Clients: nodes die via deze node lopen.
	Clients []ClientConfig `json:"clients"`
}

// EdgeConfig is voor de client (B): waar en hoe hij de tunnel opzet.
type EdgeConfig struct {
	NodeID int `json:"node_id"` // node-id van A
	// URL: https://<A fqdn> (zonder pad).
	URL string `json:"url"`
	// Fqdn van A; deel van de handtekening.
	Fqdn string `json:"fqdn"`
	// ClientID: het eigen node-id (B).
	ClientID int    `json:"client_id"`
	Secret   string `json:"secret"`
}

// ClientConfig is voor de edge (A): één node die via A loopt.
type ClientConfig struct {
	NodeID int    `json:"node_id"`
	Fqdn   string `json:"fqdn"` // NODE_DOMAIN van B; wordt altijd doorgestuurd
	Secret string `json:"secret"`
	Hosts  []Host `json:"hosts"`
}

// Host is één hostnaam van B (een domein van een site of gameserver).
type Host struct {
	Host         string        `json:"host"`
	Wildcard     bool          `json:"wildcard"`
	DNSChallenge *DNSChallenge `json:"dns_challenge"`
}

// DNSChallenge zoals in openapi.yaml.
type DNSChallenge struct {
	Provider string `json:"provider"`
	APIToken string `json:"api_token"`
}

func mac(secret string, parts ...string) string {
	m := hmac.New(sha256.New, []byte(secret))
	_, _ = io.WriteString(m, "panel-relay-v1")
	for _, p := range parts {
		_, _ = io.WriteString(m, "|"+p)
	}
	return hex.EncodeToString(m.Sum(nil))
}

// clientSig: B → A.
func clientSig(secret, edgeFqdn string, nodeID int, ts, nonce string) string {
	return mac(secret, "client", strings.ToLower(edgeFqdn), strconv.Itoa(nodeID), ts, nonce)
}

// edgeProof: A → B.
func edgeProof(secret, edgeFqdn string, nodeID int, nonce string) string {
	return mac(secret, "edge", strings.ToLower(edgeFqdn), strconv.Itoa(nodeID), nonce)
}

func equal(a, b string) bool { return hmac.Equal([]byte(a), []byte(b)) }

func yamuxConfig() *yamux.Config {
	c := yamux.DefaultConfig()
	c.LogOutput = io.Discard
	c.KeepAliveInterval = 20 * time.Second
	c.ConnectionWriteTimeout = 30 * time.Second
	c.MaxStreamWindowSize = 1 << 20
	return c
}

// normHost: lowercase, zonder poort en punt aan het eind.
func normHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if hh, _, err := net.SplitHostPort(h); err == nil {
		h = hh
	}
	return strings.TrimSuffix(h, ".")
}

// wsConn maakt van een websocket een net.Conn (binaire berichten) voor yamux.
type wsConn struct {
	ws  *websocket.Conn
	rmu sync.Mutex
	r   io.Reader
	wmu sync.Mutex
}

func newWSConn(ws *websocket.Conn) *wsConn { return &wsConn{ws: ws} }

func (c *wsConn) Read(p []byte) (int, error) {
	c.rmu.Lock()
	defer c.rmu.Unlock()
	for {
		if c.r == nil {
			t, r, err := c.ws.NextReader()
			if err != nil {
				return 0, err
			}
			if t != websocket.BinaryMessage {
				continue
			}
			c.r = r
		}
		n, err := c.r.Read(p)
		if err == io.EOF {
			c.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *wsConn) Close() error                       { return c.ws.Close() }
func (c *wsConn) LocalAddr() net.Addr                { return c.ws.LocalAddr() }
func (c *wsConn) RemoteAddr() net.Addr               { return c.ws.RemoteAddr() }
func (c *wsConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }
func (c *wsConn) SetDeadline(t time.Time) error {
	return errorsJoin(c.ws.SetReadDeadline(t), c.ws.SetWriteDeadline(t))
}

func errorsJoin(a, b error) error {
	if a != nil {
		return a
	}
	return b
}
