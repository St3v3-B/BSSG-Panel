package engine

import (
	"context"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

// PublishedPort is een poort die een container op de host publiceert.
type PublishedPort struct {
	HostIP   string
	HostPort int
	Proto    string // tcp of udp
}

// ContainerSummary is een container uit de lijst met staat, health en gepubliceerde poorten.
type ContainerSummary struct {
	ID     string
	Name   string
	Labels map[string]string
	// State: running, exited, restarting, created, paused, dead.
	State string
	// Health: healthy, unhealthy, starting of leeg (geen healthcheck).
	Health string
	Ports  []PublishedPort
}

// ContainerSummaries geeft alle containers (ook gestopte) met al deze labels; labels nil = alle containers.
func (d *Docker) ContainerSummaries(ctx context.Context, labels map[string]string) ([]ContainerSummary, error) {
	f := filters.NewArgs()
	for k, v := range labels {
		f.Add("label", k+"="+v)
	}
	list, err := d.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, err
	}
	out := make([]ContainerSummary, 0, len(list))
	for _, s := range list {
		c := ContainerSummary{ID: s.ID, Labels: s.Labels, State: s.State, Health: HealthFromStatus(s.Status)}
		if len(s.Names) > 0 {
			c.Name = strings.TrimPrefix(s.Names[0], "/")
		}
		for _, p := range s.Ports {
			if p.PublicPort != 0 {
				c.Ports = append(c.Ports, PublishedPort{HostIP: p.IP, HostPort: int(p.PublicPort), Proto: p.Type})
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// HealthFromStatus haalt de health uit de Status-tekst van `docker ps` ("Up 3 minutes (healthy)").
func HealthFromStatus(status string) string {
	switch {
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	}
	return ""
}
