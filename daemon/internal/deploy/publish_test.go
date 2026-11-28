package deploy

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"panel/daemon/internal/files"
)

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, dir, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

func newRoot(t *testing.T) (*files.Root, string) {
	dir := t.TempDir()
	return files.New(dir, os.Getuid(), os.Getgid()), dir
}

func TestPublishFirstDeploy(t *testing.T) {
	root, dir := newRoot(t)
	write(t, dir, ".panel-deploy/release-1/index.html", "v1")
	if err := publish(root, ".panel-deploy/release-1", "site/public", nil, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, dir, "site/public/index.html") != "v1" {
		t.Fatal("not published")
	}
}

func TestPublishSwapKeepsSharedPaths(t *testing.T) {
	root, dir := newRoot(t)
	write(t, dir, "public/index.html", "old")
	write(t, dir, "public/.env", "SECRET=live")
	write(t, dir, "public/wp-content/uploads/a.jpg", "photo")
	write(t, dir, "public/old-only.txt", "x")
	write(t, dir, ".panel-deploy/release-2/index.html", "new")
	write(t, dir, ".panel-deploy/release-2/.env", "SECRET=from-repo")
	write(t, dir, ".panel-deploy/release-2/wp-content/themes/t.css", "css")
	var log []string
	shared := []string{".env", "wp-content/uploads", "missing/thing"}
	if err := publish(root, ".panel-deploy/release-2", "public", shared, func(s string) { log = append(log, s) }); err != nil {
		t.Fatal(err)
	}
	checks := map[string]string{
		"public/index.html":                    "new",
		"public/.env":                          "SECRET=live",
		"public/wp-content/uploads/a.jpg":      "photo",
		"public/wp-content/themes/t.css":       "css",
		"public/old-only.txt":                  "<missing>",
		".panel-deploy/release-2/old-only.txt": "x", // de oude versie staat nu op de plek van de release
	}
	for p, want := range checks {
		if got := read(t, dir, p); got != want {
			t.Errorf("%s = %q, want %q", p, got, want)
		}
	}
	if !strings.Contains(strings.Join(log, "\n"), "kept /.env") {
		t.Errorf("log: %v", log)
	}
}

func TestPublishRollbackOnFailedSwap(t *testing.T) {
	root, dir := newRoot(t)
	write(t, dir, "public/index.html", "old")
	write(t, dir, "public/uploads/a.jpg", "photo")
	write(t, dir, ".panel-deploy/release-3/index.html", "new")
	orig := exchange
	exchange = func(*files.Root, string, string) error { return errors.New("boom") }
	defer func() { exchange = orig }()
	if err := publish(root, ".panel-deploy/release-3", "public", []string{"uploads"}, func(string) {}); err == nil {
		t.Fatal("expected an error")
	}
	if read(t, dir, "public/index.html") != "old" || read(t, dir, "public/uploads/a.jpg") != "photo" {
		t.Fatal("live site changed after a failed swap")
	}
}

func TestPublishRefusesSymlinks(t *testing.T) {
	root, dir := newRoot(t)
	outside := t.TempDir()
	write(t, outside, "keep.txt", "outside")
	// Doelmap is een symlink: niet omwisselen.
	if err := os.Symlink(outside, filepath.Join(dir, "public")); err != nil {
		t.Fatal(err)
	}
	write(t, dir, ".panel-deploy/release-4/index.html", "new")
	if err := publish(root, ".panel-deploy/release-4", "public", nil, func(string) {}); err == nil {
		t.Fatal("symlinked target accepted")
	}
	if read(t, outside, "keep.txt") != "outside" {
		t.Fatal("outside touched")
	}
	// Bronmap (uit de repo) is een symlink.
	write(t, dir, "site/index.html", "old")
	if err := os.Symlink("/", filepath.Join(dir, ".panel-deploy/release-4/dist")); err != nil {
		t.Fatal(err)
	}
	if err := publish(root, ".panel-deploy/release-4/dist", "site", nil, func(string) {}); err == nil {
		t.Fatal("symlinked source accepted")
	}
	if read(t, dir, "site/index.html") != "old" {
		t.Fatal("site changed")
	}
}

func TestPublishRepoSymlinkInSharedParent(t *testing.T) {
	root, dir := newRoot(t)
	outside := t.TempDir()
	write(t, dir, "public/wp-content/uploads/a.jpg", "photo")
	write(t, dir, ".panel-deploy/release-5/index.php", "new")
	// De repo bevat wp-content als symlink naar buiten: die mag nooit gevolgd worden.
	if err := os.Symlink(outside, filepath.Join(dir, ".panel-deploy/release-5/wp-content")); err != nil {
		t.Fatal(err)
	}
	if err := publish(root, ".panel-deploy/release-5", "public", []string{"wp-content/uploads"}, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if read(t, dir, "public/wp-content/uploads/a.jpg") != "photo" {
		t.Fatal("uploads lost")
	}
	if fi, err := os.Lstat(filepath.Join(dir, "public/wp-content")); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatal("wp-content should be a real folder")
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatal("wrote outside the site")
	}
}
