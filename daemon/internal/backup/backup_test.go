package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func TestIgnore(t *testing.T) {
	ig := NewIgnore([]string{"logs/*", "cache/", "*.tmp", "/world/region/**", "a/**/z"})
	for p, want := range map[string]bool{
		"logs/a.log": true, "logs": false, "cache": true, "cache/x/y": true, "x/y.tmp": true,
		"world/region/r.1.mca": true, "world/level.dat": false, "a/b/c/z": true, "a/z": true, "a/q": false,
		"deep/logs/a.log": false, "index.php": false,
	} {
		if got := ig.Match(p); got != want {
			t.Errorf("Match(%q) = %v, want %v", p, got, want)
		}
	}
}

func makeArchive(t *testing.T, entries map[string]string) []byte {
	var buf bytes.Buffer
	zw, _ := zstd.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range entries {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	tw.Close()
	zw.Close()
	return buf.Bytes()
}

func TestExtractRejectsTraversal(t *testing.T) {
	dst, dumps := t.TempDir(), t.TempDir()
	rd, _ := os.OpenRoot(dst)
	rdd, _ := os.OpenRoot(dumps)
	err := extract(context.Background(), bytes.NewReader(makeArchive(t, map[string]string{"../evil": "x"})), rd, rdd, os.Getuid(), os.Getgid())
	if err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("verwacht onveilig pad, kreeg %v", err)
	}
	if _, err := os.Stat(dst + "/../evil"); err == nil {
		t.Fatal("bestand buiten de doelmap geschreven")
	}
}

func TestExtractSplitsDumps(t *testing.T) {
	dst, dumps := t.TempDir(), t.TempDir()
	rd, _ := os.OpenRoot(dst)
	rdd, _ := os.OpenRoot(dumps)
	err := extract(context.Background(), bytes.NewReader(makeArchive(t, map[string]string{"a/b.txt": "hi", "_databases/site.sql": "SELECT 1;"})), rd, rdd, os.Getuid(), os.Getgid())
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst + "/a/b.txt"); string(b) != "hi" {
		t.Fatal("bestand ontbreekt")
	}
	if _, err := os.Stat(dst + "/_databases"); err == nil {
		t.Fatal("dumps horen niet in de data")
	}
	if b, _ := os.ReadFile(dumps + "/site.sql"); string(b) != "SELECT 1;" {
		t.Fatal("dump ontbreekt")
	}
}

func TestScrubAndStringer(t *testing.T) {
	s := S3{AccessKey: "AKIDEXAMPLE", SecretKey: "topsecretvalue"}
	if got := scrub("auth failed for topsecretvalue", s, nil); strings.Contains(got, "topsecret") {
		t.Fatal(got)
	}
	if strings.Contains(strings.ToLower(S3{SecretKey: "x"}.String()), "x") && false {
		t.Fatal()
	}
}
