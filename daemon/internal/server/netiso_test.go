package server

import (
	"net/netip"
	"testing"
)

func TestFreeSubnet(t *testing.T) {
	pool := netip.MustParsePrefix("10.213.0.0/16")
	pp := netip.MustParsePrefix
	got, ok := freeSubnet(pool, 28, nil, nil)
	if !ok || got != pp("10.213.0.0/28") {
		t.Fatal(got)
	}
	// bezet door een groter netwerk van iemand anders, en een eerder geprobeerd blok
	got, _ = freeSubnet(pool, 28, []netip.Prefix{pp("10.213.0.0/27"), pp("172.17.0.0/16")}, []netip.Prefix{pp("10.213.0.32/28")})
	if got != pp("10.213.0.48/28") {
		t.Fatal(got)
	}
	// /26 springt over een /28 heen naar het volgende uitgelijnde blok
	got, _ = freeSubnet(pool, 26, []netip.Prefix{pp("10.213.0.16/28")}, nil)
	if got != pp("10.213.0.64/26") {
		t.Fatal(got)
	}
	// alles bezet (de hele pool overlapt met een bestaand netwerk)
	if _, ok := freeSubnet(pool, 28, []netip.Prefix{pp("10.0.0.0/8")}, nil); ok {
		t.Fatal("verwacht: geen vrij subnet")
	}
	if _, ok := freeSubnet(netip.Prefix{}, 28, nil, nil); ok {
		t.Fatal("ongeldige pool")
	}
}
