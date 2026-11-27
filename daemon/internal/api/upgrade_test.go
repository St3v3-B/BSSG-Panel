package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"panel/daemon/internal/upgrade"
)

func upgradeAPI(t *testing.T, withSvc bool, run upgrade.Runner) http.Handler {
	t.Helper()
	a := New(Options{NodeToken: "tok"}, nil, nil, nil, func(context.Context) SystemInfo { return SystemInfo{Version: "1.2.3", Commit: "abc"} }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if withSvc {
		repo := t.TempDir()
		os.MkdirAll(filepath.Join(repo, "deploy"), 0o755)
		os.WriteFile(filepath.Join(repo, "deploy", "upgrade.sh"), []byte("#!/bin/sh\n"), 0o755)
		a.SetUpgrade(&upgrade.Service{RepoDir: repo, UpgradeDir: t.TempDir(), Run: run})
	}
	return a.Handler()
}

func do(h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestPanelUpgradeEndpoints(t *testing.T) {
	var ran []string
	h := upgradeAPI(t, true, func(_ context.Context, name string, args ...string) (string, error) {
		ran = append(ran, name+" "+strings.Join(args, " "))
		if name == "git" && strings.Contains(strings.Join(args, " "), "log") {
			return "ccc\x1f\x1fcur\x1f\n", nil
		}
		return "", nil
	})
	if w := do(h, "GET", "/api/panel-upgrade/status", "", ""); w.Code != 401 {
		t.Fatalf("no token: %d", w.Code)
	}
	if w := do(h, "POST", "/api/panel-upgrade", "", ""); w.Code != 401 {
		t.Fatalf("no token: %d", w.Code)
	}
	w := do(h, "GET", "/api/panel-upgrade/status?fetch=0", "", "tok")
	var st map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &st) != nil || st["daemon_version"] != "1.2.3" || st["daemon_commit"] != "abc" {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	for _, bad := range []string{`{"ref":"main"}`, `{"ref":"abc; reboot"}`, `{"ref":"--help"}`} {
		if w := do(h, "POST", "/api/panel-upgrade", bad, "tok"); w.Code != 400 {
			t.Fatalf("%s: %d", bad, w.Code)
		}
	}
	for _, line := range ran {
		if strings.HasPrefix(line, "systemd-run") {
			t.Fatalf("systemd-run must not run for bad refs: %v", ran)
		}
	}
	w = do(h, "POST", "/api/panel-upgrade", `{"ref":"origin/main"}`, "tok")
	if w.Code != 202 || !strings.Contains(w.Body.String(), `"unit":"panel-upgrade-`) {
		t.Fatalf("start %d %s", w.Code, w.Body)
	}
	if last := ran[len(ran)-1]; !strings.HasPrefix(last, "systemd-run --unit panel-upgrade-") || !strings.HasSuffix(last, "--ref origin/main") {
		t.Fatalf("%s", last)
	}
	if w := do(h, "POST", "/api/panel-upgrade", "", "tok"); w.Code != 202 {
		t.Fatalf("empty body: %d", w.Code)
	}
}

func TestPanelUpgradeNotLocal(t *testing.T) {
	h := upgradeAPI(t, false, nil)
	for _, c := range [][2]string{{"GET", "/api/panel-upgrade/status"}, {"POST", "/api/panel-upgrade"}} {
		w := do(h, c[0], c[1], "", "tok")
		if w.Code != 404 || !strings.Contains(w.Body.String(), "not_local") {
			t.Fatalf("%v: %d %s", c, w.Code, w.Body)
		}
	}
}
