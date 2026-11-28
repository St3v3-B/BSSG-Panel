package panel_test

import (
	"fmt"
	"testing"
	"time"

	"panel/daemon/internal/panel"
	"panel/daemon/internal/testpanel"
)

func TestPlayerEventsOrderedAndBatched(t *testing.T) {
	p := testpanel.New("tok", "node1.test")
	defer p.Close()
	p.FailNext = 1
	c := client(p, "tok")
	at := time.Now().UTC()
	for i := 0; i < panel.MaxPlayerBatch+20; i++ {
		c.ReportPlayerEvent(uuid, panel.PlayerEvent{Type: "join", At: at, Name: fmt.Sprintf("p%d", i)})
	}
	c.Wait()
	var names []string
	for _, call := range p.Calls("/api/remote/servers/" + uuid + "/players") {
		evs := call.Body["events"].([]any)
		if len(evs) > panel.MaxPlayerBatch {
			t.Fatalf("batch van %d", len(evs))
		}
		for _, e := range evs {
			names = append(names, e.(map[string]any)["name"].(string))
		}
	}
	if len(names) != panel.MaxPlayerBatch+20 {
		t.Fatalf("%d events", len(names))
	}
	for i, n := range names {
		if n != fmt.Sprintf("p%d", i) {
			t.Fatalf("volgorde: %d = %s", i, n)
		}
	}
}
