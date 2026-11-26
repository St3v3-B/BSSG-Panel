package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NetworkInfo is het deel van een Docker-netwerk dat de router nodig heeft.
type NetworkInfo struct {
	ID     string
	Name   string
	Labels map[string]string
}

// Networker is de Docker-koppeling voor het (los)koppelen van Caddy aan
// site-netwerken. DockerAPI is de echte; tests mogen hem faken.
type Networker interface {
	Network(ctx context.Context, idOrName string) (NetworkInfo, error)
	// ContainerNetworks geeft netwerk-ID → netwerknaam van een container.
	ContainerNetworks(ctx context.Context, container string) (map[string]string, error)
	Connect(ctx context.Context, networkID, container string) error
	Disconnect(ctx context.Context, networkID, container string) error
}

// ---- regels voor de netwerk-koppeling ----

// siteNetwork: alleen netwerken met panel.managed=true, panel.instance=Instance
// én panel.role=site worden gekoppeld en losgekoppeld (zie Upstream.Network).
func (c *Caddy) siteNetwork(n NetworkInfo) bool {
	return n.Labels["panel.managed"] == "true" && n.Labels["panel.instance"] == c.cfg.Instance && n.Labels["panel.role"] == "site"
}

func (c *Caddy) checkNetwork(ctx context.Context, r Route) error {
	if r.RedirectTo != "" || r.Upstream.Network == "" {
		return nil
	}
	if c.cfg.CaddyContainer == "" || c.docker == nil {
		return fmt.Errorf("proxy: %s: netwerk %q gevraagd maar CADDY_CONTAINER is niet ingesteld", r.Host, r.Upstream.Network)
	}
	n, err := c.docker.Network(ctx, r.Upstream.Network)
	if err != nil {
		return fmt.Errorf("proxy: %s: %w", r.Host, err)
	}
	if !c.siteNetwork(n) {
		return fmt.Errorf("proxy: %s: netwerk %q is geen site-netwerk van deze panel-instance (labels panel.managed, panel.instance, panel.role=site)", r.Host, r.Upstream.Network)
	}
	return nil
}

// connectNetworks koppelt Caddy aan elk netwerk waar een dynamische route naar
// wijst en geeft de IDs daarvan terug (die blijven gekoppeld).
func (c *Caddy) connectNetworks(ctx context.Context, dyn map[string]dynRoute) (map[string]bool, error) {
	keep := map[string]bool{}
	names := map[string]bool{}
	for _, d := range dyn {
		if d.network != "" {
			names[d.network] = true
		}
	}
	if len(names) == 0 || c.docker == nil || c.cfg.CaddyContainer == "" {
		if len(names) > 0 {
			return keep, errors.New("proxy: routes met netwerk maar CADDY_CONTAINER is niet ingesteld")
		}
		return keep, nil
	}
	have, err := c.docker.ContainerNetworks(ctx, c.cfg.CaddyContainer)
	if err != nil {
		return nil, err // nil = niets loskoppelen, we weten niet wat er is
	}
	var errs []error
	for name := range names {
		n, err := c.docker.Network(ctx, name)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		keep[n.ID] = true // ook bij een fout hieronder niet loskoppelen
		if !c.siteNetwork(n) {
			errs = append(errs, fmt.Errorf("proxy: netwerk %q is geen site-netwerk van deze panel-instance; niet gekoppeld", name))
			continue
		}
		if _, ok := have[n.ID]; ok {
			continue
		}
		if err := c.docker.Connect(ctx, n.ID, c.cfg.CaddyContainer); err != nil {
			errs = append(errs, err)
		}
	}
	return keep, errors.Join(errs...)
}

// disconnectNetworks koppelt Caddy los van eigen netwerken die niet in keep staan.
func (c *Caddy) disconnectNetworks(ctx context.Context, keep map[string]bool) error {
	if keep == nil || c.docker == nil || c.cfg.CaddyContainer == "" {
		return nil
	}
	have, err := c.docker.ContainerNetworks(ctx, c.cfg.CaddyContainer)
	if err != nil {
		return err
	}
	var errs []error
	for id := range have {
		if keep[id] {
			continue
		}
		n, err := c.docker.Network(ctx, id)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !c.siteNetwork(n) {
			continue
		}
		if err := c.docker.Disconnect(ctx, id, c.cfg.CaddyContainer); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// ---- DockerAPI: minimale client voor de Docker Engine-API ----

// DockerAPI praat rechtstreeks met de Docker Engine-API (unix-socket of tcp).
type DockerAPI struct {
	base string
	hc   *http.Client
}

var _ Networker = (*DockerAPI)(nil)

// NewDockerAPI: host zoals DOCKER_HOST ("unix:///var/run/docker.sock",
// "tcp://127.0.0.1:2375"); leeg = /var/run/docker.sock.
func NewDockerAPI(host string) (*DockerAPI, error) {
	if host == "" {
		host = "unix:///var/run/docker.sock"
	}
	u, err := url.Parse(host)
	if err != nil {
		return nil, fmt.Errorf("proxy: ongeldige DOCKER_HOST %q", host)
	}
	tr := &http.Transport{}
	base := ""
	switch u.Scheme {
	case "unix":
		path := u.Path
		tr.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		}
		base = "http://docker"
	case "tcp", "http":
		base = "http://" + u.Host
	default:
		return nil, fmt.Errorf("proxy: DOCKER_HOST-schema %q niet ondersteund", u.Scheme)
	}
	return &DockerAPI{base: base, hc: &http.Client{Transport: tr, Timeout: 30 * time.Second}}, nil
}

func (d *DockerAPI) call(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.hc.Do(req)
	if err != nil {
		return fmt.Errorf("proxy: Docker: %w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode/100 != 2 {
		var e struct{ Message string }
		_ = json.Unmarshal(b, &e)
		if e.Message == "" {
			e.Message = strings.TrimSpace(string(b))
		}
		return fmt.Errorf("proxy: Docker %s %s: %s: %s", method, path, resp.Status, e.Message)
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

func (d *DockerAPI) Network(ctx context.Context, idOrName string) (NetworkInfo, error) {
	var n struct {
		ID     string `json:"Id"`
		Name   string
		Labels map[string]string
	}
	if err := d.call(ctx, http.MethodGet, "/networks/"+url.PathEscape(idOrName), nil, &n); err != nil {
		return NetworkInfo{}, err
	}
	return NetworkInfo{ID: n.ID, Name: n.Name, Labels: n.Labels}, nil
}

func (d *DockerAPI) ContainerNetworks(ctx context.Context, container string) (map[string]string, error) {
	var c struct {
		NetworkSettings struct {
			Networks map[string]struct{ NetworkID string }
		}
	}
	if err := d.call(ctx, http.MethodGet, "/containers/"+url.PathEscape(container)+"/json", nil, &c); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for name, n := range c.NetworkSettings.Networks {
		out[n.NetworkID] = name
	}
	return out, nil
}

func (d *DockerAPI) Connect(ctx context.Context, networkID, container string) error {
	return d.call(ctx, http.MethodPost, "/networks/"+url.PathEscape(networkID)+"/connect", map[string]any{"Container": container}, nil)
}

func (d *DockerAPI) Disconnect(ctx context.Context, networkID, container string) error {
	return d.call(ctx, http.MethodPost, "/networks/"+url.PathEscape(networkID)+"/disconnect", map[string]any{"Container": container, "Force": false}, nil)
}
