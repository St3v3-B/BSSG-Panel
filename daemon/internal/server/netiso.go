package server

// Netwerkisolatie.
//
// Elke server (website én game-server) heeft een eigen bridge-netwerk panel-site-<uuid>
// (panel.role=site, panel.server_uuid=<uuid>): de servercontainer en zijn install-container
// draaien daarop, Caddy koppelt zich eraan voor een http-route en de daemon koppelt
// panel-mariadb voor websites met een database. Docker isoleert bridge-netwerken van elkaar,
// dus servers zien elkaar en de infra-netwerken (panel-backend, panel-db, ...) niet. Uitgaand
// internet (NAT) en gepubliceerde poorten (allocations) werken gewoon; ook een gepubliceerde
// poort van een andere server via het IP van de host (zo bereikte Velocity zijn backends altijd).
//
// enable_icc blijft aan: op het eigen netwerk staan alleen de server zelf en de infra die hem
// moet bereiken (Caddy, MariaDB); met icc=false werkt juist dat niet meer.
//
// Een Velocity-netwerk (proxy + backends, PUT /api/servers/{proxy}/network) krijgt daarnaast
// een gedeeld netwerk panel-net-<proxy-uuid> (panel.role=proxy-net, panel.server_uuid=<proxy>)
// waaraan alleen de proxy en zijn backends hangen; de proxy bereikt een backend daar als
// panel-<uuid>:<poort>. Lidmaatschap staat in $DATA_DIR/state/proxy-networks.json.
//
// Subnets komen uit Config.NetworkPool (DOCKER_NETWORK_POOL, standaard 10.213.0.0/16): /28 per
// server, /26 per proxy-netwerk. Docker's standaardpools hebben maar ruimte voor ~30 netwerken.
//
// Bestaande containers op het gedeelde "bridge"-netwerk worden bij hun volgende (her)start
// verplaatst (launch maakt de container altijd opnieuw); live omzetten zou spelers afsluiten.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"path/filepath"
	"slices"
	"strings"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/store"
)

// RoleProxyNet is panel.role van het gedeelde netwerk van een Velocity-proxy en zijn backends.
const RoleProxyNet = "proxy-net"

// ProxyNetwork is het gedeelde netwerk van proxy uuid en zijn backends.
func ProxyNetwork(uuid string) string { return "panel-net-" + uuid }

const (
	serverSubnetBits = 28
	proxySubnetBits  = 26
)

// DefaultNetworkPool is de standaard voor Config.NetworkPool.
var DefaultNetworkPool = netip.MustParsePrefix("10.213.0.0/16")

func (m *Manager) ownedNet(labels map[string]string, role, uuid string) bool {
	return labels[LabelManaged] == "true" && labels[LabelInstance] == m.cfg.Instance && labels[LabelRole] == role && (uuid == "" || labels[LabelUUID] == uuid)
}

// freeSubnet kiest het eerste /bits-blok in de pool dat geen bestaand Docker-subnet (of een
// eerder geprobeerd blok in skip) overlapt.
func freeSubnet(pool netip.Prefix, bits int, used, skip []netip.Prefix) (netip.Prefix, bool) {
	if !pool.IsValid() || bits < pool.Bits() || bits > 30 {
		return netip.Prefix{}, false
	}
	base := pool.Masked().Addr().As4()
	start := uint32(base[0])<<24 | uint32(base[1])<<16 | uint32(base[2])<<8 | uint32(base[3])
	step := uint32(1) << (32 - bits)
	count := uint32(1) << (bits - pool.Bits())
	for i := uint32(0); i < count; i++ {
		v := start + i*step
		c := netip.PrefixFrom(netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}), bits)
		if slices.ContainsFunc(used, c.Overlaps) || slices.ContainsFunc(skip, c.Overlaps) {
			continue
		}
		return c, true
	}
	return netip.Prefix{}, false
}

// createNetwork maakt een bridge-netwerk met een subnet uit de pool (of door Docker gekozen
// als er geen pool is). Een overlap met een netwerk dat intussen door iemand anders gemaakt
// is, wordt met het volgende blok opnieuw geprobeerd.
func (m *Manager) createNetwork(ctx context.Context, name string, labels map[string]string, bits int) error {
	if !m.cfg.NetworkPool.IsValid() {
		return m.eng.CreateNetwork(ctx, name, engine.NetworkOptions{Labels: labels})
	}
	m.netMu.Lock()
	defer m.netMu.Unlock()
	var skip []netip.Prefix
	for try := 0; try < 8; try++ {
		used, err := m.eng.NetworkSubnets(ctx)
		if err != nil {
			return err
		}
		sub, ok := freeSubnet(m.cfg.NetworkPool, bits, used, skip)
		if !ok {
			return fmt.Errorf("no free /%d subnet left in %s", bits, m.cfg.NetworkPool)
		}
		err = m.eng.CreateNetwork(ctx, name, engine.NetworkOptions{Labels: labels, Subnet: sub})
		if err == nil || !strings.Contains(strings.ToLower(err.Error()), "overlap") {
			return err
		}
		skip = append(skip, sub)
	}
	return fmt.Errorf("creating network %s: no non-overlapping subnet found", name)
}

// ensureServerNetwork maakt panel-site-<uuid> als het ontbreekt (en controleert anders dat het van ons is).
func (m *Manager) ensureServerNetwork(ctx context.Context, uuid string) error {
	name := SiteNetwork(uuid)
	labels, err := m.eng.NetworkLabels(ctx, name)
	switch {
	case errors.Is(err, engine.ErrNotFound):
		if err := m.createNetwork(ctx, name, m.labels(uuid, RoleSite), serverSubnetBits); err != nil {
			// Tegelijk door een andere aanroep gemaakt: dan is het er nu.
			if l, e2 := m.eng.NetworkLabels(ctx, name); e2 == nil && m.ours(l) {
				return nil
			}
			return fmt.Errorf("netwerk %s aanmaken: %w", name, err)
		}
		return nil
	case err != nil:
		return err
	case !m.ours(labels):
		return fmt.Errorf("network %s exists but does not belong to this daemon", name)
	}
	return nil
}

// ---------- Velocity-netwerken ----------

func (m *Manager) proxyNetsPath() string {
	return filepath.Join(m.cfg.DataDir, "state", "proxy-networks.json")
}

func (m *Manager) loadProxyNets() {
	g := map[string][]string{}
	if err := store.ReadJSON(m.proxyNetsPath(), &g); err != nil && !errors.Is(err, fs.ErrNotExist) {
		m.log.Error("reading proxy-networks.json failed", "err", err)
	}
	m.mu.Lock()
	m.proxyNets = g
	m.mu.Unlock()
}

// ProxyMembers geeft de backends van proxy uuid (nil als er geen netwerk is).
func (m *Manager) ProxyMembers(uuid string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return slices.Clone(m.proxyNets[uuid])
}

// proxyNetsOf geeft de proxy-netwerken waar server uuid aan hoort (als proxy of als backend).
func (m *Manager) proxyNetsOf(uuid string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []string
	for p, members := range m.proxyNets {
		if p == uuid || slices.Contains(members, uuid) {
			out = append(out, ProxyNetwork(p))
		}
	}
	slices.Sort(out)
	return out
}

// ErrBadMember: een backend is onbekend op deze node, een website, of de proxy zelf.
var ErrBadMember = errors.New("bad network member")

// SetProxyNetwork legt de backends van proxy uuid vast, maakt panel-net-<uuid> (of ruimt het op
// bij een lege lijst) en koppelt de containers die er nu zijn. Containers die later starten,
// worden bij hun start gekoppeld.
func (m *Manager) SetProxyNetwork(ctx context.Context, uuid string, members []string) error {
	p, ok := m.Get(uuid)
	if !ok {
		return ErrNotFound
	}
	if p.IsWeb() {
		return fmt.Errorf("%w: %s is a website", ErrBadMember, uuid)
	}
	clean := []string{}
	for _, b := range members {
		b = strings.ToLower(b)
		s, ok := m.Get(b)
		switch {
		case !ok:
			return fmt.Errorf("%w: %s is not on this node", ErrBadMember, b)
		case s.IsWeb() || b == p.uuid:
			return fmt.Errorf("%w: %s", ErrBadMember, b)
		}
		if !slices.Contains(clean, b) {
			clean = append(clean, b)
		}
	}
	m.netMu.Lock()
	m.mu.Lock()
	old := m.proxyNets[p.uuid]
	next := make(map[string][]string, len(m.proxyNets)+1)
	for k, v := range m.proxyNets {
		next[k] = v
	}
	if len(clean) == 0 {
		delete(next, p.uuid)
	} else {
		next[p.uuid] = clean
	}
	err := store.WriteJSON(m.proxyNetsPath(), next)
	if err == nil {
		m.proxyNets = next
	}
	m.mu.Unlock()
	m.netMu.Unlock()
	if err != nil {
		return err
	}
	name := ProxyNetwork(p.uuid)
	if len(clean) == 0 {
		return m.removeProxyNetwork(ctx, p.uuid)
	}
	if err := m.ensureProxyNetwork(ctx, p.uuid); err != nil {
		return err
	}
	for _, b := range old {
		if !slices.Contains(clean, b) {
			if err := m.eng.DisconnectNetwork(ctx, name, ContainerName(b)); err != nil && !errors.Is(err, engine.ErrNotFound) {
				m.log.Warn("disconnecting backend from proxy network", "network", name, "uuid", b, "err", err)
			}
		}
	}
	return m.connectProxyNetwork(ctx, p.uuid, clean)
}

func (m *Manager) ensureProxyNetwork(ctx context.Context, uuid string) error {
	name := ProxyNetwork(uuid)
	labels, err := m.eng.NetworkLabels(ctx, name)
	switch {
	case errors.Is(err, engine.ErrNotFound):
		if err := m.createNetwork(ctx, name, m.labels(uuid, RoleProxyNet), proxySubnetBits); err != nil {
			if l, e2 := m.eng.NetworkLabels(ctx, name); e2 == nil && m.ownedNet(l, RoleProxyNet, uuid) {
				return nil
			}
			return fmt.Errorf("netwerk %s aanmaken: %w", name, err)
		}
		return nil
	case err != nil:
		return err
	case !m.ownedNet(labels, RoleProxyNet, uuid):
		return fmt.Errorf("network %s exists but does not belong to this daemon", name)
	}
	return nil
}

// connectProxyNetwork koppelt de bestaande containers van proxy en backends; een container die
// er (nog) niet is, wordt overgeslagen.
func (m *Manager) connectProxyNetwork(ctx context.Context, proxy string, members []string) error {
	name := ProxyNetwork(proxy)
	var errs []error
	for _, u := range append([]string{proxy}, members...) {
		if err := m.eng.ConnectNetwork(ctx, name, ContainerName(u)); err != nil && !errors.Is(err, engine.ErrNotFound) {
			errs = append(errs, fmt.Errorf("connecting %s to %s: %w", ContainerName(u), name, err))
		}
	}
	return errors.Join(errs...)
}

// removeProxyNetwork koppelt alle containers los en verwijdert panel-net-<uuid> (alleen als het van ons is).
func (m *Manager) removeProxyNetwork(ctx context.Context, uuid string) error {
	name := ProxyNetwork(uuid)
	labels, err := m.eng.NetworkLabels(ctx, name)
	if errors.Is(err, engine.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !m.ownedNet(labels, RoleProxyNet, uuid) {
		return nil
	}
	if nets, err := m.eng.ListNetworks(ctx, map[string]string{LabelManaged: "true", LabelInstance: m.cfg.Instance, LabelRole: RoleProxyNet, LabelUUID: uuid}); err == nil {
		for _, n := range nets {
			if n.Name != name {
				continue
			}
			for _, c := range n.Containers {
				_ = m.eng.DisconnectNetwork(ctx, name, c)
			}
		}
	}
	if err := m.eng.RemoveNetwork(ctx, name); err != nil && !errors.Is(err, engine.ErrNotFound) {
		return fmt.Errorf("netwerk %s verwijderen: %w", name, err)
	}
	return nil
}

// attachProxyNetworks koppelt de (net gemaakte) container van server uuid aan de
// proxy-netwerken waar hij bij hoort. Aangeroepen tussen Create en Start.
func (m *Manager) attachProxyNetworks(ctx context.Context, uuid string) error {
	var errs []error
	for _, name := range m.proxyNetsOf(uuid) {
		proxy := strings.TrimPrefix(name, "panel-net-")
		if err := m.ensureProxyNetwork(ctx, proxy); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := m.eng.ConnectNetwork(ctx, name, ContainerName(uuid)); err != nil && !errors.Is(err, engine.ErrNotFound) {
			errs = append(errs, fmt.Errorf("connecting to %s: %w", name, err))
		}
	}
	return errors.Join(errs...)
}

// forgetProxyNetworks haalt server uuid uit alle proxy-netwerken (bij verwijderen). Was hij
// zelf een proxy, dan gaat zijn netwerk weg.
func (m *Manager) forgetProxyNetworks(ctx context.Context, uuid string) {
	m.netMu.Lock()
	m.mu.Lock()
	next := map[string][]string{}
	changed := false
	emptied := []string{uuid}
	for p, members := range m.proxyNets {
		if p == uuid {
			changed = true
			continue
		}
		if i := slices.Index(members, uuid); i >= 0 {
			members = slices.Delete(slices.Clone(members), i, i+1)
			changed = true
		}
		if len(members) > 0 {
			next[p] = members
		} else {
			emptied = append(emptied, p)
		}
	}
	var err error
	if changed {
		if err = store.WriteJSON(m.proxyNetsPath(), next); err == nil {
			m.proxyNets = next
		}
	}
	m.mu.Unlock()
	m.netMu.Unlock()
	if err != nil {
		m.log.Warn("writing proxy-networks.json failed", "err", err)
	}
	for _, p := range emptied {
		if err := m.removeProxyNetwork(ctx, p); err != nil {
			m.log.Warn("proxy-netwerk opruimen", "uuid", p, "err", err)
		}
	}
}

// reconcileProxyNetworks: bij de start en periodiek. Elk vastgelegd proxy-netwerk bestaat en
// draaiende leden hangen eraan; proxy-netwerken van ons zonder vastlegging gaan weg.
func (m *Manager) reconcileProxyNetworks(ctx context.Context) {
	m.mu.RLock()
	groups := make(map[string][]string, len(m.proxyNets))
	for k, v := range m.proxyNets {
		groups[k] = slices.Clone(v)
	}
	m.mu.RUnlock()
	for p, members := range groups {
		if _, ok := m.Get(p); !ok {
			continue
		}
		if err := m.ensureProxyNetwork(ctx, p); err != nil {
			m.log.Warn("proxy-netwerk", "uuid", p, "err", err)
			continue
		}
		var running []string
		for _, b := range members {
			if s, ok := m.Get(b); ok && (s.State() == StateOnline || s.State() == StateStarting) {
				running = append(running, b)
			}
		}
		if s, ok := m.Get(p); ok && (s.State() == StateOnline || s.State() == StateStarting) {
			if err := m.connectProxyNetwork(ctx, p, running); err != nil {
				m.log.Warn("proxy-netwerk koppelen", "uuid", p, "err", err)
			}
		} else if len(running) > 0 {
			for _, b := range running {
				_ = m.eng.ConnectNetwork(ctx, ProxyNetwork(p), ContainerName(b))
			}
		}
	}
	nets, err := m.eng.ListNetworks(ctx, map[string]string{LabelManaged: "true", LabelInstance: m.cfg.Instance, LabelRole: RoleProxyNet})
	if err != nil {
		return
	}
	for _, n := range nets {
		if _, ok := groups[n.Labels[LabelUUID]]; ok {
			continue
		}
		if err := m.removeProxyNetwork(ctx, n.Labels[LabelUUID]); err != nil {
			m.log.Warn("verweesd proxy-netwerk", "network", n.Name, "err", err)
		}
	}
}

// removeOrphanServerNetworks verwijdert panel-site-<uuid>-netwerken van ons waarvan de server
// niet (meer) bestaat en waar geen container meer aan hangt (anders alleen een waarschuwing:
// een gekoppelde infra-container laten we met rust).
func (m *Manager) removeOrphanServerNetworks(ctx context.Context) {
	nets, err := m.eng.ListNetworks(ctx, map[string]string{LabelManaged: "true", LabelInstance: m.cfg.Instance, LabelRole: RoleSite})
	if err != nil {
		return
	}
	for _, n := range nets {
		u := n.Labels[LabelUUID]
		if _, ok := m.Get(u); ok || n.Name != SiteNetwork(u) {
			continue
		}
		var other []string
		for _, c := range n.Containers {
			if c == m.cfg.MariaDB {
				_ = m.eng.DisconnectNetwork(ctx, n.Name, c)
				continue
			}
			other = append(other, c)
		}
		if len(other) > 0 {
			m.log.Warn("verweesd server-netwerk heeft nog containers; niet verwijderd", "network", n.Name, "containers", other)
			continue
		}
		if err := m.eng.RemoveNetwork(ctx, n.Name); err != nil && !errors.Is(err, engine.ErrNotFound) {
			m.log.Warn("verweesd server-netwerk verwijderen", "network", n.Name, "err", err)
		}
	}
}
