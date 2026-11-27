// Package proxy is de koppeling tussen daemon en Caddy.
//
// Dit bestand (de interface en de types) is van de orchestrator. De daemon programmeert
// tegen Router; web-hosting levert de echte implementatie (Caddy admin-API) in dit pakket.
// Wijzigingen aan dit bestand alleen via de orchestrator.
package proxy

import (
	"context"
	"errors"
	"time"
)

// SSLStatus is de certificaatstatus van één hostnaam.
type SSLStatus string

const (
	SSLPending  SSLStatus = "pending"   // route staat, nog geen poging gedaan
	SSLDNSWrong SSLStatus = "dns_wrong" // ACME-challenge faalt omdat DNS niet naar deze node wijst
	SSLIssuing  SSLStatus = "issuing"   // Caddy is bezig
	SSLActive   SSLStatus = "active"    // geldig certificaat
	SSLFailed   SSLStatus = "failed"    // andere fout, zie RouteStatus.Error
)

// Upstream is waar Caddy het verkeer van een route aflevert.
type Upstream struct {
	// Container is de Docker-containernaam (DNS-naam binnen Network).
	Container string
	// Network is het Docker-netwerk van de site. De implementatie zorgt dat Caddy aan
	// dit netwerk gekoppeld is zolang er routes naar verwijzen, en koppelt hem los
	// als de laatste route weg is. Leeg = Caddy kan de container al bereiken.
	// Alleen netwerken met panel.managed=true, panel.instance=<Config.Instance> en
	// panel.role=site worden gekoppeld en losgekoppeld (de daemon zet die labels).
	Network string
	// Port in de container.
	Port int
}

// DNSChallenge is nodig voor wildcard-certificaten.
type DNSChallenge struct {
	Provider string // "cloudflare"
	APIToken string
}

// Route koppelt één hostnaam aan een upstream of een redirect.
type Route struct {
	Host       string // "example.nl" of "*.example.nl", altijd lowercase
	ServerUUID string
	Upstream   Upstream
	// RedirectTo: als gezet, antwoordt Caddy met 308 naar https://RedirectTo{uri}
	// en wordt Upstream genegeerd.
	RedirectTo   string
	Wildcard     bool
	DNSChallenge *DNSChallenge
	// Placeholder: als gezet, serveert Caddy direct een standaardpagina voor deze staat
	// in plaats van naar de upstream te proxyen. De daemon zet hem bij elke statuswijziging
	// van de site (SetRoute opnieuw). Leeg = normaal proxyen; is de upstream dan toch
	// onbereikbaar, dan toont Caddy de pagina van PlaceholderUnavailable.
	Placeholder Placeholder
}

// Placeholder bepaalt welke standaardpagina Caddy toont (status 503, Retry-After).
type Placeholder string

const (
	PlaceholderNone        Placeholder = ""
	PlaceholderInstalling  Placeholder = "installing"  // "deze website wordt ingericht"
	PlaceholderOffline     Placeholder = "offline"     // "staat uit, start hem via het panel"
	PlaceholderDisk        Placeholder = "disk"        // "tijdelijk uit: opslag vol, beheer via het panel"
	PlaceholderUnavailable Placeholder = "unavailable" // upstream onbereikbaar terwijl hij online hoort te zijn
)

// RouteStatus is de actuele toestand van een route in Caddy.
type RouteStatus struct {
	Host      string
	SSL       SSLStatus
	Error     string
	CheckedAt time.Time
}

// ErrNotFound: de hostnaam heeft geen route.
var ErrNotFound = errors.New("proxy: route not found")

// Router beheert de dynamische routes in Caddy. De vaste routes (panel en
// daemon-subdomein) staan in de Caddy-basisconfig en vallen hierbuiten: een
// implementatie mag die nooit verwijderen of overschrijven.
//
// De daemon is de bron van waarheid: hij bewaart de routeset zelf en roept Sync aan
// bij zijn start, na een Caddy-herstart en elke 5 minuten. Implementaties moeten
// veilig zijn voor gelijktijdig gebruik.
type Router interface {
	// SetRoute voegt een route toe of vervangt die met dezelfde Host.
	SetRoute(ctx context.Context, r Route) error
	// RemoveRoute haalt de route weg; ErrNotFound als hij niet bestond.
	RemoveRoute(ctx context.Context, host string) error
	// Sync maakt de dynamische routes in Caddy exact gelijk aan routes
	// (toevoegen, bijwerken én verwijderen wat er niet in staat).
	Sync(ctx context.Context, routes []Route) error
	// Status geeft de SSL-status van één hostnaam; ErrNotFound als er geen route is.
	// Kan enkele seconden duren (TLS-dial, Docker-logs, DNS-lookup): niet in een strakke
	// lus aanroepen, maar periodiek (bv. per minuut) of op verzoek, en het resultaat cachen.
	Status(ctx context.Context, host string) (RouteStatus, error)
}

// HealthChecker is optioneel: implementeert een Router dit, dan roept de daemon
// Healthy elke 15 s aan en doet hij Sync zodra Caddy na een fout weer gezond is
// (= Caddy is herstart en is zijn dynamische routes kwijt).
type HealthChecker interface {
	Healthy(ctx context.Context) error
}

// Config voor de Caddy-implementatie. De daemon vult hem uit de omgeving
// (CADDY_ADMIN_URL, CADDY_CONTAINER, PANEL_INSTANCE) en roept NewCaddy aan
// (caddy.go, door web-hosting). Is CADDY_ADMIN_URL leeg, dan gebruikt de daemon NewFake.
type Config struct {
	// AdminURL: unix:///run/panel/caddy-admin.sock (productie) of http://127.0.0.1:<poort> (tests).
	AdminURL       string
	CaddyContainer string // containernaam van Caddy, voor koppelen aan site-netwerken
	Instance       string // PANEL_INSTANCE; alleen netwerken met dit label aanraken
	// TLSAddr: waar Caddy HTTPS serveert, voor de SSL-controle (CADDY_TLS_ADDR,
	// standaard 127.0.0.1:443).
	TLSAddr string
}
