package daemon

import (
	"testing"
	"time"

	"panel/daemon/internal/engine"
)

func TestImageUpdateAPI(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, nil, nil, "", nil, "")
	u1 := randUUID()
	sp := testSpec(u1)
	sp["skip_install"] = true
	sp["image_update"] = map[string]any{"policy": "notify"}
	h.expect("POST", "/api/servers", sp, 202)

	bad := testSpec(randUUID())
	bad["image_update"] = map[string]any{"policy": "sometimes"}
	h.expect("POST", "/api/servers", bad, 400)

	h.expect("POST", "/api/images/check", nil, 202)
	waitFor(t, "image report", 5*time.Second, func() bool { return len(h.panel.Calls("/api/remote/node/images")) > 0 })
	c := h.panel.Calls("/api/remote/node/images")[0]
	list, _ := c.Body["servers"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["uuid"] != u1 || list[0].(map[string]any)["update_available"] != false {
		t.Fatalf("%v", c.Body)
	}

	h.expect("POST", "/api/servers/"+u1+"/image-update", nil, 202)
	waitFor(t, "update report", 5*time.Second, func() bool { return len(h.panel.Calls("/api/remote/servers/"+u1+"/image-update")) > 0 })
	r := h.panel.Calls("/api/remote/servers/" + u1 + "/image-update")[0]
	if r.Body["successful"] != true || r.Body["mode"] != "manual" {
		t.Fatalf("%v", r.Body)
	}
	h.expect("POST", "/api/servers/"+randUUID()+"/image-update", nil, 404)
	h.expect("POST", "/api/servers/"+u1+"/image-update", nil, 202)
}
