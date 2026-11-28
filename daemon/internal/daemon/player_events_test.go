package daemon

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"panel/daemon/internal/engine"
)

const (
	tJoin  = `^\[\d{2}:\d{2}:\d{2} INFO\]: (?<name>\.?[A-Za-z0-9_]{1,16}) joined the game$`
	tLeave = `^\[\d{2}:\d{2}:\d{2} INFO\]: (?<name>\.?[A-Za-z0-9_]{1,16}) left the game$`
	tUUID  = `^\[\d{2}:\d{2}:\d{2} INFO\]: UUID of player (?<name>\.?[A-Za-z0-9_]{1,16}) is (?<uuid>[0-9a-fA-F-]{32,36})$`
)

func playerEvents(h *harness) []map[string]any {
	var out []map[string]any
	for _, c := range h.panel.Calls("/api/remote/servers/" + u1 + "/players") {
		evs, _ := c.Body["events"].([]any)
		for _, e := range evs {
			out = append(out, e.(map[string]any))
		}
	}
	return out
}

func summarizeEvents(evs []map[string]any) string {
	s := ""
	for _, e := range evs {
		s += fmt.Sprintf("%v:%v:%v:%v ", e["type"], e["name"], e["reason"], e["player_uuid"])
	}
	return s
}

func TestPlayerEventsReported(t *testing.T) {
	eng := engine.NewFake()
	var run atomic.Int32
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		n := run.Add(1)
		c.Println("Done (1.0s)! ready")
		c.Println("[12:00:00 INFO]: UUID of player Steve is 069A79F4-44E9-4726-A5BE-FCA90E38AAF5")
		c.Println("[12:00:01 INFO]: Steve joined the game")
		c.Println("[12:00:02 INFO]: <Steve> Alex joined the game")
		if n == 2 {
			time.Sleep(100 * time.Millisecond)
			c.Exit(1) // crash
			return
		}
		c.Println("[12:00:03 INFO]: Alex joined the game")
		c.Println("[12:00:04 INFO]: Alex left the game")
		exited := c.Exited()
		for {
			select {
			case l := <-c.Stdin():
				if l == "stop" {
					c.Println("[12:00:05 INFO]: Steve left the game")
					c.Exit(0)
					return
				}
			case <-exited:
				return
			}
		}
	}
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", fastBackoff)
	startServer(t, h, func(sp map[string]any) {
		sp["player_events"] = map[string]string{"join": tJoin, "leave": tLeave, "uuid": tUUID}
	})
	h.waitState(u1, "online", 5*time.Second)
	waitFor(t, "joins", 5*time.Second, func() bool { return len(playerEvents(h)) >= 3 })
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 5*time.Second)
	waitFor(t, "stopped", 5*time.Second, func() bool { return len(playerEvents(h)) >= 5 })
	got := summarizeEvents(playerEvents(h))
	want := "join:Steve:<nil>:069a79f4-44e9-4726-a5be-fca90e38aaf5 join:Alex:<nil>:<nil> leave:Alex:leave:<nil> leave:Steve:server_stop:<nil> stopped:<nil>:server_stop:<nil> "
	if got != want {
		t.Fatalf("events:\n%s\nverwacht\n%s", got, want)
	}
	for _, e := range playerEvents(h) {
		if at, err := time.Parse(time.RFC3339Nano, e["at"].(string)); err != nil || time.Since(at) > time.Minute {
			t.Fatalf("at: %v", e["at"])
		}
	}

	// crash: stopped met reden crash
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	waitFor(t, "crash", 5*time.Second, func() bool { return len(playerEvents(h)) >= 7 })
	evs := playerEvents(h)[5:]
	if s := summarizeEvents(evs); s != "join:Steve:<nil>:069a79f4-44e9-4726-a5be-fca90e38aaf5 stopped:<nil>:crash:<nil> " {
		t.Fatalf("crash: %s", s)
	}
}

func TestNoPlayerEventsWithoutPatterns(t *testing.T) {
	eng := engine.NewFake()
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			c.Exit(0)
			return
		}
		c.Println("Done (1.0s)! ready")
		c.Println("[12:00:01 INFO]: Steve joined the game")
		engine.DefaultBehavior(c)
	}
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", fastBackoff)
	startServer(t, h, nil)
	h.waitState(u1, "online", 5*time.Second)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "stop"}, 202)
	h.waitState(u1, "offline", 5*time.Second)
	time.Sleep(100 * time.Millisecond)
	if evs := playerEvents(h); len(evs) != 0 {
		t.Fatalf("%v", evs)
	}
}

func TestPlayerEventsRejectsBadPattern(t *testing.T) {
	h := newHarnessWith(t, engine.NewFake(), nil, nil, "", nil, "", nil)
	sp := testSpec(u1)
	sp["player_events"] = map[string]string{"join": `^(\w+) joined$`, "leave": tLeave}
	h.expect("POST", "/api/servers", sp, 400)
}
