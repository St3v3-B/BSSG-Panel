package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
)

func fastBackoff(_ *config.Config, d *Deps) { d.Server.RestartBackoff = 10 * time.Millisecond }

func crashEvents(h *harness) []map[string]any {
	var out []map[string]any
	for _, c := range h.panel.Calls("/api/remote/servers/" + u1 + "/event") {
		out = append(out, c.Body)
	}
	return out
}

func startServer(t *testing.T, h *harness, mutate func(map[string]any)) {
	sp := testSpec(u1)
	sp["config_files"] = []any{}
	sp["start_on_install"] = true
	if mutate != nil {
		mutate(sp)
	}
	h.expect("POST", "/api/servers", sp, 202)
}

func TestCrashReported(t *testing.T) {
	eng := engine.NewFake()
	var n atomic.Int32
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		c.Println("Done (1.0s)! ready")
		if n.Add(1) == 1 {
			for i := 0; i < 40; i++ {
				c.Println("line " + string(rune('A'+i%26)))
			}
			c.Println("Exception in thread main")
			time.Sleep(200 * time.Millisecond)
			c.Exit(1)
			return
		}
		engine.DefaultBehavior(c)
	}
	dir := t.TempDir()
	h := newHarnessWith(t, eng, nil, nil, dir, nil, "", fastBackoff)
	startServer(t, h, nil)
	h.waitState(u1, "online", 5*time.Second)
	waitFor(t, "crash-event", 5*time.Second, func() bool { return len(crashEvents(h)) == 1 })
	ev := crashEvents(h)[0]
	if ev["type"] != "crashed" || ev["exit_code"] != float64(1) || ev["restart"] != "disabled" || ev["oom"] == true {
		t.Fatalf("%v", ev)
	}
	tail := ev["log_tail"].([]any)
	if len(tail) != 30 || tail[29] != "Exception in thread main" {
		t.Fatalf("tail: %d %v", len(tail), tail[len(tail)-1])
	}
	h.waitState(u1, "offline", 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	if h.state(u1).State != "offline" || len(crashEvents(h)) != 1 {
		t.Fatal("geen auto-restart verwacht")
	}
}

func TestStopIsNoCrash(t *testing.T) {
	eng := engine.NewFake()
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", fastBackoff)
	startServer(t, h, nil)
	h.waitState(u1, "online", 5*time.Second)
	// via de API: stop-opdracht
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 3*time.Second)
	// kill (exit 137)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 3*time.Second)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "kill"}, 202)
	h.waitState(u1, "offline", 3*time.Second)
	// `stop` in de console (exit 0, geen stop-opdracht van het panel)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 3*time.Second)
	h.expect("POST", "/api/servers/"+u1+"/commands", map[string]any{"commands": []string{"stop"}}, 204)
	h.waitState(u1, "offline", 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	if ev := crashEvents(h); len(ev) != 0 {
		t.Fatalf("onverwachte events: %v", ev)
	}
}

func TestOOMCrashWithCrashReport(t *testing.T) {
	eng := engine.NewFake()
	dir := t.TempDir()
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		c.Println("Done (1.0s)! ready")
		time.Sleep(100 * time.Millisecond)
		cr := filepath.Join(dir, "volumes", u1, "crash-reports")
		_ = os.MkdirAll(cr, 0o755)
		_ = os.WriteFile(filepath.Join(cr, "crash-2026-11-27_10.00.00-server.txt"), []byte("---- Minecraft Crash Report ----\nDescription: Ticking entity\n"+strings.Repeat("at x\n", 100)), 0o644)
		c.ExitOOM()
	}
	h := newHarnessWith(t, eng, nil, nil, dir, nil, "", fastBackoff)
	startServer(t, h, nil)
	waitFor(t, "crash-event", 5*time.Second, func() bool { return len(crashEvents(h)) == 1 })
	ev := crashEvents(h)[0]
	rep, _ := ev["crash_report"].(string)
	if ev["oom"] != true || ev["exit_code"] != float64(137) || !strings.HasPrefix(rep, "---- Minecraft Crash Report ----") || len(rep) > 4000 {
		t.Fatalf("%v", ev)
	}
}

func TestAutoRestartLimit(t *testing.T) {
	eng := engine.NewFake()
	var starts atomic.Int32
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		starts.Add(1)
		c.Println("Done (1.0s)! ready")
		time.Sleep(30 * time.Millisecond)
		c.Exit(2)
	}
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", fastBackoff)
	startServer(t, h, func(sp map[string]any) { sp["auto_restart"] = map[string]any{"max_per_10min": 2} })
	waitFor(t, "gave_up", 8*time.Second, func() bool {
		for _, e := range crashEvents(h) {
			if e["restart"] == "gave_up" {
				return true
			}
		}
		return false
	})
	time.Sleep(300 * time.Millisecond)
	evs := crashEvents(h)
	var restarted, gaveUp int
	for _, e := range evs {
		switch e["restart"] {
		case "restarted":
			restarted++
		case "gave_up":
			gaveUp++
		}
	}
	if restarted != 2 || gaveUp != 1 || len(evs) != 3 || starts.Load() != 3 {
		t.Fatalf("restarted=%d gaveUp=%d events=%d starts=%d", restarted, gaveUp, len(evs), starts.Load())
	}
	h.waitState(u1, "offline", 3*time.Second)
	// ongeldige limiet
	bad := testSpec("1b7c2d1e-1111-4222-8333-444455556666")
	bad["auto_restart"] = map[string]any{"max_per_10min": 0}
	h.expect("POST", "/api/servers", bad, 400)
}

func TestManualPowerCancelsAutoRestart(t *testing.T) {
	eng := engine.NewFake()
	var starts atomic.Int32
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		if starts.Add(1) == 1 {
			c.Println("Done (1.0s)! ready")
			time.Sleep(50 * time.Millisecond)
			c.Exit(1)
			return
		}
		engine.DefaultBehavior(c)
	}
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", func(c *config.Config, d *Deps) { d.Server.RestartBackoff = 600 * time.Millisecond })
	startServer(t, h, func(sp map[string]any) { sp["auto_restart"] = map[string]any{"max_per_10min": 3} })
	waitFor(t, "event", 5*time.Second, func() bool { return len(crashEvents(h)) == 1 })
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	time.Sleep(900 * time.Millisecond)
	if starts.Load() != 1 || h.state(u1).State != "offline" {
		t.Fatalf("starts=%d state=%s", starts.Load(), h.state(u1).State)
	}
}
