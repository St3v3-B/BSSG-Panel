// Package config leest de omgeving van de daemon (deploy/panel.env.example).
package config

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Config is de configuratie van de daemon.
type Config struct {
	NodeToken      string
	NodeDomain     string
	PanelDomain    string
	PanelURL       string
	DaemonSocket   string
	DaemonPort     int
	SFTPPort       int
	DataDir        string
	CaddyAdminURL  string
	CaddyContainer string
	CaddyTLSAddr   string
	Instance       string
	ExtraLabels    map[string]string
	// MariaDBContainer wordt aan site-netwerken gekoppeld (MARIADB_CONTAINER).
	MariaDBContainer string
}

// Load leest de configuratie met getenv (os.Getenv in productie).
func Load(getenv func(string) string) (Config, error) {
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	c := Config{
		NodeToken:        get("NODE_TOKEN", ""),
		NodeDomain:       strings.ToLower(get("NODE_DOMAIN", "")),
		PanelDomain:      strings.ToLower(get("PANEL_DOMAIN", "")),
		PanelURL:         strings.TrimRight(get("PANEL_URL", ""), "/"),
		DaemonSocket:     get("DAEMON_SOCKET", "/run/panel/daemon.sock"),
		DataDir:          get("DATA_DIR", "/var/lib/panel"),
		CaddyAdminURL:    get("CADDY_ADMIN_URL", ""),
		CaddyContainer:   get("CADDY_CONTAINER", "panel-caddy"),
		CaddyTLSAddr:     get("CADDY_TLS_ADDR", "127.0.0.1:443"),
		Instance:         get("PANEL_INSTANCE", "main"),
		MariaDBContainer: get("MARIADB_CONTAINER", "panel-mariadb"),
	}
	var errs []error
	if c.NodeToken == "" {
		errs = append(errs, errors.New("NODE_TOKEN is missing"))
	}
	if c.NodeDomain == "" {
		errs = append(errs, errors.New("NODE_DOMAIN is missing"))
	}
	if c.PanelURL == "" {
		if c.PanelDomain == "" {
			errs = append(errs, errors.New("PANEL_URL or PANEL_DOMAIN is missing"))
		} else {
			c.PanelURL = "https://" + c.PanelDomain
		}
	} else if u, err := url.Parse(c.PanelURL); err != nil || u.Host == "" {
		errs = append(errs, fmt.Errorf("PANEL_URL invalid: %q", c.PanelURL))
	}
	var err error
	if c.DaemonPort, err = port(get("DAEMON_PORT", "8080")); err != nil {
		errs = append(errs, fmt.Errorf("DAEMON_PORT: %w", err))
	}
	if c.SFTPPort, err = port(get("SFTP_PORT", "2022")); err != nil {
		errs = append(errs, fmt.Errorf("SFTP_PORT: %w", err))
	}
	if c.ExtraLabels, err = ParseLabels(getenv("DOCKER_EXTRA_LABELS")); err != nil {
		errs = append(errs, fmt.Errorf("DOCKER_EXTRA_LABELS: %w", err))
	}
	return c, errors.Join(errs...)
}

func port(s string) (int, error) {
	p, err := strconv.Atoi(s)
	if err != nil || p < 0 || p > 65535 {
		return 0, fmt.Errorf("invalid port %q", s)
	}
	return p, nil
}

// ParseLabels leest "k=v,k2=v2". De labels panel.managed en panel.instance zijn
// voorbehouden.
func ParseLabels(s string) (map[string]string, error) {
	out := map[string]string{}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			return nil, fmt.Errorf("invalid label %q (expected k=v)", part)
		}
		if k == "panel.managed" || k == "panel.instance" || k == "panel.server_uuid" || k == "panel.role" {
			return nil, fmt.Errorf("label %q is voorbehouden", k)
		}
		out[k] = strings.TrimSpace(v)
	}
	return out, nil
}

// AllowedOrigins zijn de Origins die de websocket accepteert: https://$PANEL_DOMAIN en
// de origin van PANEL_URL (die is ook van het panel).
func (c Config) AllowedOrigins() []string {
	var out []string
	if c.PanelDomain != "" {
		out = append(out, "https://"+c.PanelDomain)
	}
	if u, err := url.Parse(c.PanelURL); err == nil && u.Host != "" {
		o := u.Scheme + "://" + u.Host
		if len(out) == 0 || out[0] != o {
			out = append(out, o)
		}
	}
	return out
}
