package engine

import (
	"context"
	"net/netip"
	"strings"

	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
)

// ErrNetworkNotFound: het netwerk bestaat niet.
var ErrNetworkNotFound = ErrNotFound

// Networks is het netwerkdeel van Docker.
type Networks interface {
	// NetworkLabels geeft de labels van een netwerk; ErrNotFound als het niet bestaat.
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
	CreateNetwork(ctx context.Context, name string, o NetworkOptions) error
	RemoveNetwork(ctx context.Context, name string) error
	// ConnectNetwork koppelt een container; al gekoppeld is geen fout.
	ConnectNetwork(ctx context.Context, network, container string) error
	// DisconnectNetwork koppelt los; niet gekoppeld is geen fout.
	DisconnectNetwork(ctx context.Context, network, container string) error
	// NetworkSubnets geeft de IPv4-subnets van alle Docker-netwerken (ook die van anderen),
	// om een vrij subnet te kiezen.
	NetworkSubnets(ctx context.Context) ([]netip.Prefix, error)
	// ListNetworks geeft de netwerken met al deze labels, met de namen van de gekoppelde containers.
	ListNetworks(ctx context.Context, labels map[string]string) ([]NetworkInfo, error)
}

// NetworkOptions voor CreateNetwork.
type NetworkOptions struct {
	Labels   map[string]string
	Internal bool
	// Subnet: leeg = Docker kiest uit zijn standaardpools.
	Subnet netip.Prefix
}

// NetworkInfo is een netwerk uit ListNetworks.
type NetworkInfo struct {
	Name       string
	Labels     map[string]string
	Containers []string
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

func (d *Docker) CreateNetwork(ctx context.Context, name string, o NetworkOptions) error {
	opts := network.CreateOptions{Driver: "bridge", Internal: o.Internal, Labels: o.Labels}
	if o.Subnet.IsValid() {
		opts.IPAM = &network.IPAM{Driver: "default", Config: []network.IPAMConfig{{Subnet: o.Subnet.String()}}}
	}
	_, err := d.cli.NetworkCreate(ctx, name, opts)
	return wrap(err)
}

func (d *Docker) NetworkSubnets(ctx context.Context) ([]netip.Prefix, error) {
	list, err := d.cli.NetworkList(ctx, network.ListOptions{})
	if err != nil {
		return nil, wrap(err)
	}
	var out []netip.Prefix
	for _, n := range list {
		for _, c := range n.IPAM.Config {
			if p, err := netip.ParsePrefix(c.Subnet); err == nil && p.Addr().Is4() {
				out = append(out, p.Masked())
			}
		}
	}
	return out, nil
}

func (d *Docker) ListNetworks(ctx context.Context, labels map[string]string) ([]NetworkInfo, error) {
	f := filters.NewArgs()
	for k, v := range labels {
		f.Add("label", k+"="+v)
	}
	list, err := d.cli.NetworkList(ctx, network.ListOptions{Filters: f})
	if err != nil {
		return nil, wrap(err)
	}
	out := make([]NetworkInfo, 0, len(list))
	for _, n := range list {
		// NetworkList vult Containers niet; inspect per netwerk.
		r, err := d.cli.NetworkInspect(ctx, n.ID, network.InspectOptions{})
		if err != nil {
			continue
		}
		ni := NetworkInfo{Name: r.Name, Labels: r.Labels}
		for _, c := range r.Containers {
			ni.Containers = append(ni.Containers, c.Name)
		}
		out = append(out, ni)
	}
	return out, nil
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
