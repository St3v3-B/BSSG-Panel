package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSeedIconOnlyWhenMissing(t *testing.T) {
	data := t.TempDir()
	m := &Manager{cfg: Config{DataDir: data, UID: os.Getuid(), GID: os.Getgid()}}
	s := &Server{uuid: "11111111-1111-1111-1111-111111111111", m: m}
	dir := m.volume(s.uuid)
	_ = os.MkdirAll(dir, 0o755)
	s.seedIcon()
	b, err := os.ReadFile(filepath.Join(dir, "server-icon.png"))
	if err != nil || len(b) < 100 {
		t.Fatal("logo niet geschreven", err)
	}
	_ = os.WriteFile(filepath.Join(dir, "server-icon.png"), []byte("eigen"), 0o644)
	s.seedIcon()
	if b, _ := os.ReadFile(filepath.Join(dir, "server-icon.png")); string(b) != "eigen" {
		t.Fatal("bestaand icoon overschreven")
	}
}
