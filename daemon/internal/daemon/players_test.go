package daemon

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/mcproto"
)

func TestPlayersEndpoint(t *testing.T) {
	var fail atomic.Bool
	var pinged atomic.Value
	mut := func(_ *config.Config, d *Deps) {
		d.Server.StatusPinger = func(_ context.Context, addr string) (mcproto.Status, error) {
			pinged.Store(addr)
			if fail.Load() {
				return mcproto.Status{}, errors.New("geen antwoord")
			}
			var st mcproto.Status
			st.Players.Online, st.Players.Max = 3, 20
			st.Version.Name = "Paper 1.21.4"
			return st, nil
		}
	}
	h := newHarnessWith(t, engine.NewFake(), nil, nil, t.TempDir(), nil, "", mut)
	port := freePort(t)
	sp := testSpec(u1)
	sp["allocations"] = []map[string]any{{"ip": "0.0.0.0", "port": port, "primary": true}}
	sp["config_files"] = []any{}
	sp["start_on_install"] = true

	// Onbekende server en zonder token.
	h.expect("GET", "/api/servers/"+u1+"/players", nil, 404)
	if r := h.doTok("GET", "/api/servers/"+u1+"/players", nil, ""); r.Code != 401 {
		t.Fatal("zonder token", r.Code)
	}

	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "online", 5*time.Second)
	var p struct {
		Online  *int    `json:"online"`
		Max     *int    `json:"max"`
		Version *string `json:"version"`
	}
	h.expect("GET", "/api/servers/"+u1+"/players", nil, 200).json(t, &p)
	if p.Online == nil || *p.Online != 3 || *p.Max != 20 || p.Version == nil || *p.Version != "Paper 1.21.4" {
		t.Fatalf("spelers: %+v", p)
	}
	if a, _ := pinged.Load().(string); a != net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) {
		t.Fatal("ping-adres (0.0.0.0 → 127.0.0.1)", a)
	}

	fail.Store(true)
	p.Online, p.Max = nil, nil
	h.expect("GET", "/api/servers/"+u1+"/players", nil, 200).json(t, &p)
	if p.Online != nil || p.Max != nil {
		t.Fatalf("geen antwoord moet null geven: %+v", p)
	}

	// Gestopt: geen ping.
	fail.Store(false)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "kill"}, 202)
	h.waitState(u1, "offline", 5*time.Second)
	pinged.Store("")
	h.expect("GET", "/api/servers/"+u1+"/players", nil, 200).json(t, &p)
	if p.Online != nil {
		t.Fatal("offline server gaf spelers")
	}
	if a, _ := pinged.Load().(string); a != "" {
		t.Fatal("offline server werd gepingd")
	}
}
