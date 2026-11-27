package daemon

import (
	"context"
	"net/netip"
	"testing"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/proxy"
)

// TestGameServerOwnNetwork: game-server en zijn install-container draaien op panel-site-<uuid>
// (niet op het gedeelde "bridge"), met een subnet uit de pool; poorten blijven gepubliceerd.
func TestGameServerOwnNetwork(t *testing.T) {
	eng := engine.NewFake()
	var installNet string
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			installNet = c.Config.NetworkMode
		}
		engine.DefaultBehavior(c)
	}
	h := newHarness(t, eng, proxy.NewFake(), nil, "", nil, "")
	const ua = "0b7c2d1e-aaaa-4222-8333-000000000001"
	const ub = "0b7c2d1e-bbbb-4222-8333-000000000002"
	for i, u := range []string{ua, ub} {
		sp := testSpec(u)
		sp["config_files"] = []any{}
		sp["allocations"] = []map[string]any{{"ip": "127.0.0.1", "port": 25565 + i, "primary": true}}
		h.expect("POST", "/api/servers", sp, 202)
		h.waitState(u, "offline", 5*time.Second)
		if installNet != "panel-site-"+u {
			t.Fatalf("install-container op %q", installNet)
		}
		h.expect("POST", "/api/servers/"+u+"/power", map[string]string{"action": "start"}, 202)
		h.waitState(u, "online", 5*time.Second)
	}
	pool := netip.MustParsePrefix("10.252.0.0/16")
	var subs []netip.Prefix
	for _, u := range []string{ua, ub} {
		cfg := eng.Container("panel-" + u).Config
		n := eng.Network("panel-site-" + u)
		if cfg.NetworkMode != "panel-site-"+u || n == nil || len(n.Connected) != 1 || !n.Connected["panel-"+u] {
			t.Fatalf("%s: network %q %+v", u, cfg.NetworkMode, n)
		}
		if n.Labels["panel.role"] != "site" || n.Labels["panel.server_uuid"] != u || n.Internal {
			t.Fatalf("labels %+v", n)
		}
		if !pool.Contains(n.Subnet.Addr()) || n.Subnet.Bits() != 28 {
			t.Fatalf("subnet %s", n.Subnet)
		}
		if len(cfg.Ports) != 2 {
			t.Fatalf("poorten: %+v", cfg.Ports)
		}
		subs = append(subs, n.Subnet)
	}
	if subs[0].Overlaps(subs[1]) {
		t.Fatalf("subnets overlappen: %v", subs)
	}
	h.expect("DELETE", "/api/servers/"+ua, nil, 204)
	if eng.Network("panel-site-"+ua) != nil {
		t.Fatal("netwerk niet opgeruimd")
	}
	// Verweesd netwerk (server bestaat niet meer, niets gekoppeld): weg bij reconcile.
	const ghost = "0b7c2d1e-cccc-4222-8333-000000000003"
	eng.AddNetwork("panel-site-"+ghost, map[string]string{"panel.managed": "true", "panel.instance": "unit", "panel.role": "site", "panel.server_uuid": ghost})
	eng.AddNetwork("panel-site-other", map[string]string{"panel.managed": "true", "panel.instance": "andere", "panel.role": "site", "panel.server_uuid": ghost})
	h.d.Manager().ReconcileNetworks(context.Background())
	if eng.Network("panel-site-"+ghost) != nil || eng.Network("panel-site-other") == nil || eng.Network("panel-site-"+ub) == nil {
		t.Fatal("verweesde netwerken verkeerd opgeruimd")
	}
}

// TestProxyNetwork: PUT /network koppelt proxy en backends aan panel-net-<proxy>, ook na een
// herstart van een server of de daemon; verwijderde leden en servers gaan eraf.
func TestProxyNetwork(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, proxy.NewFake(), nil, "", nil, "")
	const px = "0b7c2d1e-0000-4222-8333-00000000000a"
	const b1 = "0b7c2d1e-0001-4222-8333-00000000000b"
	const b2 = "0b7c2d1e-0002-4222-8333-00000000000c"
	const other = "0b7c2d1e-0003-4222-8333-00000000000d"
	for i, u := range []string{px, b1, b2, other} {
		sp := testSpec(u)
		sp["config_files"] = []any{}
		sp["skip_install"] = true
		sp["allocations"] = []map[string]any{{"ip": "127.0.0.1", "port": 30000 + i, "primary": true}}
		h.expect("POST", "/api/servers", sp, 202)
		h.waitState(u, "offline", 5*time.Second)
	}
	start := func(u string) {
		t.Helper()
		h.expect("POST", "/api/servers/"+u+"/power", map[string]string{"action": "start"}, 202)
		h.waitState(u, "online", 5*time.Second)
	}
	start(px)
	start(b1)
	net := "panel-net-" + px

	h.expect("PUT", "/api/servers/"+px+"/network", map[string]any{"members": []string{px}}, 400)
	h.expect("PUT", "/api/servers/"+px+"/network", map[string]any{"members": []string{"0b7c2d1e-9999-4222-8333-000000000000"}}, 400)
	h.expect("PUT", "/api/servers/0b7c2d1e-9999-4222-8333-000000000000/network", map[string]any{"members": []string{}}, 404)
	var got struct {
		Members []string `json:"members"`
		Network string   `json:"network"`
	}
	h.expect("PUT", "/api/servers/"+px+"/network", map[string]any{"members": []string{b1, b2}}, 200).json(t, &got)
	if got.Network != net || len(got.Members) != 2 {
		t.Fatalf("%+v", got)
	}
	n := eng.Network(net)
	if n == nil || n.Labels["panel.role"] != "proxy-net" || n.Labels["panel.server_uuid"] != px || n.Subnet.Bits() != 26 {
		t.Fatalf("%+v", n)
	}
	// draaiend: proxy en b1 gekoppeld; b2 (gestopt) bij zijn start; other nooit
	if !n.Connected["panel-"+px] || !n.Connected["panel-"+b1] || len(n.Connected) != 2 {
		t.Fatalf("gekoppeld: %v", n.Connected)
	}
	start(b2)
	start(other)
	if n := eng.Network(net); !n.Connected["panel-"+b2] || n.Connected["panel-"+other] {
		t.Fatalf("na start: %v", n.Connected)
	}
	if eng.Network("panel-site-" + other).Connected["panel-"+b1] {
		t.Fatal("backend op het netwerk van een andere server")
	}
	// herstart van de proxy: nieuwe container hangt er weer aan
	h.expect("POST", "/api/servers/"+px+"/power", map[string]string{"action": "restart"}, 202)
	time.Sleep(300 * time.Millisecond)
	h.waitState(px, "online", 5*time.Second)
	if !eng.Network(net).Connected["panel-"+px] {
		t.Fatal("proxy na herstart niet gekoppeld")
	}
	// daemon-herstart: lidmaatschap blijft, koppeling hersteld
	_ = eng.DisconnectNetwork(context.Background(), net, "panel-"+b1)
	h.restart()
	h.expect("GET", "/api/servers/"+px+"/network", nil, 200).json(t, &got)
	if len(got.Members) != 2 {
		t.Fatalf("na herstart: %+v", got)
	}
	if !eng.Network(net).Connected["panel-"+b1] {
		t.Fatal("b1 na daemon-herstart niet opnieuw gekoppeld")
	}
	// lid eruit
	h.expect("PUT", "/api/servers/"+px+"/network", map[string]any{"members": []string{b2}}, 200)
	if n := eng.Network(net); n.Connected["panel-"+b1] || !n.Connected["panel-"+b2] {
		t.Fatalf("na verwijderen lid: %v", n.Connected)
	}
	// lid verwijderd van de node
	h.expect("DELETE", "/api/servers/"+b2, nil, 204)
	h.expect("GET", "/api/servers/"+px+"/network", nil, 200).json(t, &got)
	if len(got.Members) != 0 || got.Network != "" || eng.Network(net) != nil {
		t.Fatalf("na delete backend: %+v", got)
	}
	// lege lijst / proxy weg: netwerk weg
	h.expect("PUT", "/api/servers/"+px+"/network", map[string]any{"members": []string{b1}}, 200)
	h.expect("DELETE", "/api/servers/"+px, nil, 204)
	if eng.Network(net) != nil {
		t.Fatal("proxy-netwerk niet opgeruimd")
	}
	// verweesd proxy-netwerk van ons: weg bij reconcile
	eng.AddNetwork("panel-net-"+other, map[string]string{"panel.managed": "true", "panel.instance": "unit", "panel.role": "proxy-net", "panel.server_uuid": other})
	_ = eng.ConnectNetwork(context.Background(), "panel-net-"+other, "panel-"+other)
	h.d.Manager().ReconcileNetworks(context.Background())
	if eng.Network("panel-net-"+other) != nil {
		t.Fatal("verweesd proxy-netwerk niet opgeruimd")
	}
}

// TestLegacyBridgeMigration: een draaiende container van vóór de netwerkisolatie (op "bridge")
// blijft na een daemon-herstart gewoon draaien en verhuist bij zijn volgende herstart naar
// panel-site-<uuid>; de data blijft staan.
func TestLegacyBridgeMigration(t *testing.T) {
	eng := engine.NewFake()
	dir := t.TempDir()
	h := newHarness(t, eng, proxy.NewFake(), nil, dir, nil, "")
	sp := testSpec(u1)
	sp["config_files"] = []any{}
	sp["skip_install"] = true
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "offline", 5*time.Second)
	if c, b, _ := h.raw("PUT", "/api/servers/"+u1+"/files/contents?path=/world.dat", []byte("wereld")); c >= 300 {
		t.Fatalf("%d %s", c, b)
	}
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	// Daemon stopt; de container wordt vervangen door een "oude" op bridge.
	h.stop()
	old := eng.Container("panel-" + u1).Config
	_ = eng.Remove(context.Background(), "panel-"+u1)
	old.NetworkMode = "bridge"
	id, err := eng.Create(context.Background(), old)
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.Start(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	h.start()
	h.waitState(u1, "online", 5*time.Second)
	if c := eng.Container("panel-" + u1); c == nil || c.ID != id {
		t.Fatal("oude container niet behouden bij de daemon-start")
	}
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "restart"}, 202)
	waitFor(t, "nieuwe container", 5*time.Second, func() bool {
		c := eng.Container("panel-" + u1)
		return c != nil && c.ID != id
	})
	h.waitState(u1, "online", 5*time.Second)
	if c := eng.Container("panel-" + u1); c.Config.NetworkMode != "panel-site-"+u1 {
		t.Fatalf("na herstart op %q", c.Config.NetworkMode)
	}
	if c, b, _ := h.raw("GET", "/api/servers/"+u1+"/files/contents?path=/world.dat", nil); c != 200 || string(b) != "wereld" {
		t.Fatalf("data: %d %q", c, b)
	}
}
