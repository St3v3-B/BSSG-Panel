package engine

import (
	"context"
	"strings"

	"github.com/docker/docker/api/types/network"
)

// ErrNetworkNotFound: het netwerk bestaat niet.
var ErrNetworkNotFound = ErrNotFound

// Networks is het netwerkdeel van Docker.
type Networks interface {
	// NetworkLabels geeft de labels van een netwerk; ErrNotFound als het niet bestaat.
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
	CreateNetwork(ctx context.Context, name string, labels map[string]string, internal bool) error
	RemoveNetwork(ctx context.Context, name string) error
	// ConnectNetwork koppelt een container; al gekoppeld is geen fout.
	ConnectNetwork(ctx context.Context, network, container string) error
	// DisconnectNetwork koppelt los; niet gekoppeld is geen fout.
	DisconnectNetwork(ctx context.Context, network, container string) error
}

func (d *Docker) NetworkLabels(ctx context.Context, name string) (map[string]string, error) {
	r, err := d.cli.NetworkInspect(ctx, name, network.InspectOptions{})
	if err != nil {
		return nil, wrap(err)
	}
	if r.Name != name {
		return nil, ErrNotFound // Docker matcht ook op id-prefix
	}
	if r.Labels == nil {
		r.Labels = map[string]string{}
	}
	return r.Labels, nil
}

func (d *Docker) CreateNetwork(ctx context.Context, name string, labels map[string]string, internal bool) error {
	_, err := d.cli.NetworkCreate(ctx, name, network.CreateOptions{Driver: "bridge", Internal: internal, Labels: labels})
	return wrap(err)
}

func (d *Docker) RemoveNetwork(ctx context.Context, name string) error {
	return wrap(d.cli.NetworkRemove(ctx, name))
}

func (d *Docker) ConnectNetwork(ctx context.Context, net, container string) error {
	err := d.cli.NetworkConnect(ctx, net, container, nil)
	if err != nil && strings.Contains(err.Error(), "already exists") {
		return nil
	}
	return wrap(err)
}

func (d *Docker) DisconnectNetwork(ctx context.Context, net, container string) error {
	err := d.cli.NetworkDisconnect(ctx, net, container, true)
	if err != nil && (strings.Contains(err.Error(), "is not connected") || strings.Contains(err.Error(), "not found")) {
		return nil
	}
	return wrap(err)
}
