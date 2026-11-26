package files

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func setup(t *testing.T) (*Root, string) {
	t.Helper()
	base := t.TempDir()
	data := filepath.Join(base, "data")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{data, outside, filepath.Join(data, "sub")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	must(t, os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("geheim"), 0o644))
	must(t, os.WriteFile(filepath.Join(data, "readme.txt"), []byte("hallo\n"), 0o644))
	must(t, os.Symlink(outside, filepath.Join(data, "uit")))
	must(t, os.Symlink("/etc/passwd", filepath.Join(data, "passwd")))
	must(t, os.Symlink("../readme.txt", filepath.Join(data, "sub", "binnen")))
	return New(data, os.Getuid(), os.Getgid()), outside
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestClean(t *testing.T) {
	for in, want := range map[string]string{"/": ".", "": ".", "/a/b/": "a/b", "a/./b": "a/b", "/a/../b": "b", "//x": "x"} {
		got, err := Clean(in)
		if err != nil || got != want {
			t.Errorf("Clean(%q) = %q, %v; wil %q", in, got, err, want)
		}
	}
	for _, in := range []string{"/..", "../x", "/a/../../x", "a\x00b"} {
		if _, err := Clean(in); !errors.Is(err, ErrBadPath) {
			t.Errorf("Clean(%q): wil ErrBadPath, kreeg %v", in, err)
		}
	}
}

func TestEscapeViaSymlinks(t *testing.T) {
	r, outside := setup(t)
	if _, _, err := r.OpenRead("/uit/secret.txt"); !errors.Is(err, ErrEscape) {
		t.Fatalf("lezen via symlink-map: %v", err)
	}
	if _, _, err := r.OpenRead("/passwd"); !errors.Is(err, ErrEscape) {
		t.Fatalf("lezen via absolute symlink: %v", err)
	}
	if _, err := r.Open("/uit/nieuw.txt", os.O_WRONLY|os.O_CREATE, 0o644); err == nil {
		t.Fatal("schrijven via symlink naar buiten lukte")
	}
	if _, err := os.Stat(filepath.Join(outside, "nieuw.txt")); err == nil {
		t.Fatal("bestand buiten de root aangemaakt")
	}
	if _, err := r.List("/uit"); !errors.Is(err, ErrEscape) {
		t.Fatalf("list via symlink: %v", err)
	}
	if err := r.Mkdir("/uit/x"); err == nil {
		t.Fatal("mkdir via symlink lukte")
	}
	if err := r.Rename("/uit/secret.txt", "/gestolen.txt"); err == nil {
		t.Fatal("rename van buiten lukte")
	}
	// Symlink zelf verwijderen mag, het doel blijft staan.
	must(t, r.RemoveAll("/uit"))
	if _, err := os.Stat(filepath.Join(outside, "secret.txt")); err != nil {
		t.Fatal("doel van de symlink is verwijderd")
	}
	// Symlink binnen de root werkt.
	f, _, err := r.OpenRead("/sub/binnen")
	must(t, err)
	b, _ := io.ReadAll(f)
	f.Close()
	if string(b) != "hallo\n" {
		t.Fatalf("binnen-symlink: %q", b)
	}
}

func TestListAndOps(t *testing.T) {
	r, _ := setup(t)
	l, err := r.List("/")
	must(t, err)
	if len(l) == 0 || !l[0].IsDirectory || l[0].Name != "sub" {
		t.Fatalf("list: %+v", l)
	}
	var link Entry
	for _, e := range l {
		if e.Name == "uit" {
			link = e
		}
	}
	if !link.IsSymlink || link.IsDirectory {
		t.Fatalf("symlink naar buiten mag geen map lijken: %+v", link)
	}
	must(t, r.Mkdir("/a/b"))
	if err := r.Mkdir("/a/b"); !errors.Is(err, ErrExists) {
		t.Fatalf("mkdir bestaand: %v", err)
	}
	f, err := r.Open("/a/b/c.txt", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	must(t, err)
	_, _ = f.Write([]byte("x"))
	f.Close()
	must(t, r.Rename("/a/b/c.txt", "/a/d.txt"))
	if err := r.Rename("/a/d.txt", "/readme.txt"); !errors.Is(err, ErrExists) {
		t.Fatalf("rename naar bestaand: %v", err)
	}
	if err := r.Rename("/a", "/a/b/x"); !errors.Is(err, ErrBadPath) {
		t.Fatalf("rename in zichzelf: %v", err)
	}
	if err := r.Remove("/"); !errors.Is(err, ErrBadPath) {
		t.Fatalf("root verwijderen: %v", err)
	}
	must(t, r.RemoveAll("/a"))
	if _, err := r.Stat("/a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("na RemoveAll: %v", err)
	}
	e, err := r.Stat("/readme.txt")
	must(t, err)
	if e.Size != 6 || e.MimeType != "text/plain" || e.Mode != "-rw-r--r--" || e.Path != "/readme.txt" {
		t.Fatalf("stat: %+v", e)
	}
}

func TestCompressDecompress(t *testing.T) {
	r, outside := setup(t)
	e, err := r.Compress("/", []string{"readme.txt", "sub", "uit"}, Unlimited)
	must(t, err)
	if e.Size == 0 {
		t.Fatal("leeg archief")
	}
	must(t, r.Mkdir("/x"))
	must(t, r.Rename(e.Path, "/x/a.tar.gz"))
	must(t, r.Decompress("/x/a.tar.gz", Unlimited))
	f, _, err := r.OpenRead("/x/readme.txt")
	must(t, err)
	f.Close()
	if _, err := r.Readlink("/x/sub/binnen"); err != nil {
		t.Fatal(err)
	}
	// De symlink naar buiten is als symlink ingepakt, niet de inhoud van buiten.
	if _, _, err := r.OpenRead("/x/uit/secret.txt"); !errors.Is(err, ErrEscape) {
		t.Fatalf("uitgepakte symlink: %v", err)
	}
	// Budget: te klein.
	if _, err := r.Compress("/", []string{"readme.txt"}, 5); !errors.Is(err, ErrDiskFull) {
		t.Fatalf("budget: %v", err)
	}

	// Zip met ../ en absolute paden.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range []string{"../../outside/evil.txt", "/abs.txt", "ok/goed.txt"} {
		w, _ := zw.Create(n)
		_, _ = w.Write([]byte("z"))
	}
	zw.Close()
	zf, err := r.Open("/z.zip", os.O_WRONLY|os.O_CREATE, 0o644)
	must(t, err)
	_, _ = zf.Write(buf.Bytes())
	zf.Close()
	must(t, r.Decompress("/z.zip", Unlimited))
	if _, err := os.Stat(filepath.Join(outside, "evil.txt")); err == nil {
		t.Fatal("zip-slip")
	}
	if _, err := r.Stat("/ok/goed.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Stat("/abs.txt"); err != nil {
		t.Fatal("absoluut pad hoort binnen de map te landen:", err)
	}
	if err := r.Decompress("/readme.txt", Unlimited); !errors.Is(err, ErrBadFormat) {
		t.Fatal(err)
	}
}
