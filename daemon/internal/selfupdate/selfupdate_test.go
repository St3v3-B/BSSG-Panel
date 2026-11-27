package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func server(t *testing.T, bin []byte, sum string) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/join/daemon/amd64.sha256", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(sum + "\n")) })
	mux.HandleFunc("/join/daemon/amd64", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(bin) })
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestUpdateReplacesBinary(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "panel-daemon")
	_ = os.WriteFile(exe, []byte("old"), 0o755)
	nw := []byte("new binary")
	u := &Updater{PanelURL: server(t, nw, sum(nw)).URL, Exe: exe, Arch: "amd64"}
	ch, err := u.Run(context.Background())
	if err != nil || !ch {
		t.Fatal(ch, err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new binary" {
		t.Fatal(string(b))
	}
	if fi, _ := os.Stat(exe); fi.Mode().Perm() != 0o755 {
		t.Fatal(fi.Mode())
	}
	// Tweede keer: al de huidige.
	if ch, err := u.Run(context.Background()); err != nil || ch {
		t.Fatal(ch, err)
	}
	if m, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".panel-daemon.update.*")); len(m) != 0 {
		t.Fatal("temp bestand blijft", m)
	}
}

func TestUpdateRejectsBadSum(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "panel-daemon")
	_ = os.WriteFile(exe, []byte("old"), 0o755)
	u := &Updater{PanelURL: server(t, []byte("evil"), sum([]byte("other"))).URL, Exe: exe, Arch: "amd64"}
	if _, err := u.Run(context.Background()); err == nil {
		t.Fatal("verwacht sha256-fout")
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatal("oude binary moet blijven")
	}
}

func TestUpdateRejectsArch(t *testing.T) {
	if _, err := (&Updater{PanelURL: "http://x", Exe: "/x", Arch: "386"}).Run(context.Background()); err == nil {
		t.Fatal("arch")
	}
}
