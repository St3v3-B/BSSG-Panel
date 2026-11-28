package daemon

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const u2 = "0b7c2d1e-2222-4222-8333-444455556666"

// Kopie maken op dezelfde node: POST /transfer/copy kopieert de datamap zonder het panel, en
// export/copy met live=1 werken ook als de bron draait.
func TestTransferCopy(t *testing.T) {
	h, vol := newFilesServer(t, 0)
	if err := os.MkdirAll(filepath.Join(vol, "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(vol, "world", "level.dat"), []byte("wereld"), 0o644)
	_ = os.Symlink("readme.txt", filepath.Join(vol, "link"))

	sp := testSpec(u2)
	sp["config_files"] = []any{}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u2, "offline", 5*time.Second)
	dst := filepath.Join(h.cfg.DataDir, "volumes", u2)

	// Foute aanvragen.
	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": u2}, 400)
	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": "nope"}, 400)
	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": "0b7c2d1e-9999-4222-8333-444455556666"}, 404)

	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": u1}, 204)
	if b, err := os.ReadFile(filepath.Join(dst, "world", "level.dat")); err != nil || string(b) != "wereld" {
		t.Fatal("kopie mist level.dat", err, string(b))
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "readme.txt")); string(b) != "hallo\n" {
		t.Fatal("readme", string(b))
	}
	if l, err := os.Readlink(filepath.Join(dst, "link")); err != nil || l != "readme.txt" {
		t.Fatal("symlink", l, err)
	}
	// Bron ongewijzigd.
	if b, _ := os.ReadFile(filepath.Join(vol, "world", "level.dat")); string(b) != "wereld" {
		t.Fatal("bron veranderd")
	}

	// Bron draait: zonder live 409, met live gaat het.
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]any{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": u1}, 409)
	h.expect("GET", "/api/servers/"+u1+"/transfer/export", nil, 409)
	_ = os.WriteFile(filepath.Join(vol, "nieuw.txt"), []byte("live"), 0o644)
	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": u1, "live": true}, 204)
	if b, _ := os.ReadFile(filepath.Join(dst, "nieuw.txt")); string(b) != "live" {
		t.Fatal("live-kopie", string(b))
	}
	if c, b, _ := h.raw("GET", "/api/servers/"+u1+"/transfer/export?live=1", nil); c != 200 || len(b) == 0 {
		t.Fatal("live export", c)
	}

	// Doel draait: altijd 409.
	h.expect("POST", "/api/servers/"+u2+"/power", map[string]any{"action": "start"}, 202)
	h.waitState(u2, "online", 5*time.Second)
	h.expect("POST", "/api/servers/"+u2+"/transfer/copy", map[string]any{"source_uuid": u1, "live": true}, 409)
}
