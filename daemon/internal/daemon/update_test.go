package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/selfupdate"
)

func TestUpdateEndpoint(t *testing.T) {
	nw := []byte("nieuwe daemon")
	sum := sha256.Sum256(nw)
	hexSum := hex.EncodeToString(sum[:])
	mux := http.NewServeMux()
	mux.HandleFunc("/join/daemon/amd64.sha256", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(hexSum)) })
	mux.HandleFunc("/join/daemon/amd64", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(nw) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	exe := filepath.Join(t.TempDir(), "panel-daemon")
	_ = os.WriteFile(exe, []byte("oud"), 0o755)
	restarted := make(chan struct{}, 1)
	h := newHarnessWith(t, engine.NewFake(), nil, nil, "", nil, "", func(_ *config.Config, d *Deps) {
		d.Updater = &selfupdate.Updater{PanelURL: srv.URL, Exe: exe, Arch: "amd64"}
		d.Restart = func() { restarted <- struct{}{} }
	})
	// Zonder (of met een verkeerd) token: 401.
	if r := h.doTok("POST", "/api/update", nil, ""); r.Code != 401 {
		t.Fatal(r.Code)
	}
	if r := h.doTok("POST", "/api/update", nil, "fout"); r.Code != 401 {
		t.Fatal(r.Code)
	}
	h.expect("POST", "/api/update", nil, 202)
	if b, _ := os.ReadFile(exe); string(b) != "nieuwe daemon" {
		t.Fatal("binary niet vervangen:", string(b))
	}
	select {
	case <-restarted:
	case <-time.After(3 * time.Second):
		t.Fatal("geen herstart")
	}
	// Opnieuw: al bijgewerkt, geen herstart.
	h.expect("POST", "/api/update", nil, 204)
	select {
	case <-restarted:
		t.Fatal("onverwachte herstart")
	case <-time.After(800 * time.Millisecond):
	}
}
