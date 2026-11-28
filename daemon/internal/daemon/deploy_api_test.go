package daemon

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"panel/daemon/internal/engine"
)

// TestDeployAPI: endpoints, foutcodes en de melding aan het panel (met de fake-engine).
const deployWebUUID = "0b7c2d1e-7777-4222-8333-444455556666"

func TestDeployAPI(t *testing.T) {
	u2 := deployWebUUID
	eng := engine.NewFake()
	release := make(chan struct{})
	eng.Behavior = func(c *engine.FakeContainer) {
		switch {
		case strings.HasSuffix(c.Config.Name, "-deploy-git"):
			var buf bytes.Buffer
			tw := tar.NewWriter(&buf)
			_ = tw.WriteHeader(&tar.Header{Name: "index.html", Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
			_, _ = tw.Write([]byte("v1"))
			_ = tw.Close()
			for _, m := range c.Config.Mounts {
				if m.Target == "/cache" {
					_ = os.WriteFile(filepath.Join(m.Source, "release.tar"), buf.Bytes(), 0o644)
				}
			}
			c.Println("::commit::0123456789abcdef0123456789abcdef01234567\x1fAda\x1f2026-11-01T10:00:00Z\x1fHello")
			c.Exit(0)
		case strings.HasSuffix(c.Config.Name, "-deploy-build"):
			<-release
			var vol string
			for _, m := range c.Config.Mounts {
				if m.Target == "/home/container" {
					vol = m.Source
				}
			}
			dir := filepath.Join(vol, ".panel-deploy", "release-7")
			_ = os.MkdirAll(dir, 0o755)
			_ = os.WriteFile(filepath.Join(dir, "index.html"), []byte("v1"), 0o644)
			c.Exit(0)
		default:
			engine.DefaultBehavior(c)
		}
	}
	h := newHarness(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, "")
	game := testSpec(u1)
	h.expect("POST", "/api/servers", game, 202)
	web := map[string]any{
		"uuid": u2, "type": "web", "image": "fake/web:1", "http_port": 8080, "startup": "nginx",
		"stop": map[string]string{"type": "signal", "value": "SIGTERM"}, "skip_install": true,
		"limits":  map[string]any{"cpu_pct": 100, "memory_mb": 256, "swap_mb": 0, "disk_mb": 1024},
		"install": map[string]string{"image": "fake/install:1", "script": "true"},
	}
	h.expect("POST", "/api/servers", web, 202)
	h.waitState(u1, "offline", 5*time.Second)
	req := map[string]any{
		"deploy_id": 7, "repo_url": "https://git.example.test/a/site.git", "branch": "main",
		"auth": map[string]any{"type": "token", "token": "tok_abcdef"}, "target_dir": "/public", "source_dir": "/",
		"shared_paths": []string{}, "build": map[string]string{"command": "make", "image": "fake/build:1"}, "restart": false,
	}
	h.expect("POST", "/api/servers/"+u1+"/deploy", req, 400) // geen website
	bad := map[string]any{}
	for k, v := range req {
		bad[k] = v
	}
	bad["repo_url"] = "ext::sh -c id"
	h.expect("POST", "/api/servers/"+u2+"/deploy", bad, 400)
	h.doTok("POST", "/api/servers/"+u2+"/deploy", req, "wrong") // 401 elders getest
	var p struct {
		Deploy *struct {
			DeployID int    `json:"deploy_id"`
			Phase    string `json:"phase"`
		} `json:"deploy"`
	}
	h.expect("GET", "/api/servers/"+u2+"/deploy", nil, 200).json(t, &p)
	if p.Deploy != nil {
		t.Fatal("nothing should be running")
	}
	h.expect("POST", "/api/servers/"+u2+"/deploy/7/cancel", nil, 404)
	h.expect("POST", "/api/servers/"+u2+"/deploy", req, 202)
	h.expect("POST", "/api/servers/"+u2+"/deploy", req, 409)
	waitFor(t, "building", 5*time.Second, func() bool {
		h.expect("GET", "/api/servers/"+u2+"/deploy", nil, 200).json(t, &p)
		return p.Deploy != nil && p.Deploy.Phase == "building"
	})
	close(release)
	waitFor(t, "melding", 5*time.Second, func() bool {
		c := h.panel.Calls("/api/remote/deploys/7")
		return len(c) == 1 && c[0].Body["status"] == "succeeded"
	})
	c := h.panel.Calls("/api/remote/deploys/7")[0]
	if commit, _ := c.Body["commit"].(map[string]any); commit["message"] != "Hello" {
		t.Fatalf("report %+v", c.Body)
	}
	h.expect("POST", "/api/git/host-key", map[string]any{"host": "-oProxy", "port": 22}, 400)
	h.expect("POST", "/api/git/host-key", map[string]any{"host": "127.0.0.1", "port": 1}, 502)
}
