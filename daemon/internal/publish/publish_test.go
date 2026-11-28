package publish

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sort"
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

func read(dir, rel string) string {
	b, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		return "<missing>"
	}
	return string(b)
}

// tree geeft alle bestanden onder dir als "pad=inhoud" (gesorteerd), zonder de werkmappen.
func tree(t *testing.T, dir string) string {
	t.Helper()
	var out []string
	_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if strings.HasPrefix(rel, ".panel-publish-") {
			return filepath.SkipDir
		}
		if fi.Mode().IsRegular() {
			b, _ := os.ReadFile(p)
			out = append(out, rel+"="+string(b))
		} else if fi.Mode()&os.ModeSymlink != 0 {
			l, _ := os.Readlink(p)
			out = append(out, rel+"->"+l)
		}
		return nil
	})
	sort.Strings(out)
	return strings.Join(out, "\n")
}

func roots(t *testing.T) (prod *files.Root, prodDir string, stag *files.Root, stagDir string) {
	prodDir, stagDir = t.TempDir(), t.TempDir()
	return files.New(prodDir, os.Getuid(), os.Getgid()), prodDir, files.New(stagDir, os.Getuid(), os.Getgid()), stagDir
}

// fill zet staging in de werkmap van productie, zoals de API dat doet (tar-stroom).
func fill(t *testing.T, prod, stag *files.Root, id int64) {
	t.Helper()
	dir, err := Prepare(prod, id)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := stag.ExportTarSkip(&buf, Internal); err != nil {
		t.Fatal(err)
	}
	if err := prod.ImportTarInto(dir, &buf, files.Unlimited); err != nil {
		t.Fatal(err)
	}
}

func site(t *testing.T, prodDir, stagDir string) {
	write(t, prodDir, "wp-config.php", "<?php // productie-db")
	write(t, prodDir, "public/index.php", "oud")
	write(t, prodDir, "public/oud-alleen.txt", "weg")
	write(t, prodDir, "public/wp-content/uploads/2026/foto.jpg", "nieuwe-bestelling")
	write(t, prodDir, ".panel-deploy/home/x", "deploy")
	write(t, prodDir, ".panel-wp-setup.json", "prod-setup")
	write(t, prodDir, "php/00-panel.ini", "memory_limit=512M")

	write(t, stagDir, "wp-config.php", "<?php // staging-db")
	write(t, stagDir, "public/index.php", "nieuw")
	write(t, stagDir, "public/nieuw.txt", "nieuw")
	write(t, stagDir, "public/wp-content/uploads/2025/oud.jpg", "staging-upload")
	write(t, stagDir, "public/.env", "STAGING=1")
	write(t, stagDir, ".panel-wp-setup.json", "staging-setup")
	write(t, stagDir, "php/00-panel.ini", "memory_limit=128M")
}

func TestCompile(t *testing.T) {
	ps, err := Compile([]string{"wp-config.php", ".env", "/php/00-panel.ini", "public/wp-content/uploads/", "*.log"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		rel  string
		dir  bool
		want bool
	}{
		{"wp-config.php", false, true},
		{"public/wp-config.php", false, true},
		{"public/.env", false, true},
		{"php/00-panel.ini", false, true},
		{"x/php/00-panel.ini", false, false},
		{"public/wp-content/uploads", true, true},
		{"public/wp-content/uploads", false, false},
		{"public/wp-content/themes", true, false},
		{"logs/error.log", false, true},
		{"index.php", false, false},
	}
	for _, c := range cases {
		if got := ps.Match(c.rel, c.dir); got != c.want {
			t.Errorf("Match(%q, %v) = %v, want %v", c.rel, c.dir, got, c.want)
		}
	}
	for _, bad := range []string{"", "../etc", "a/../b", "a/**/b", "[", "a\\b"} {
		if _, err := Compile([]string{bad}); !errors.Is(err, ErrBadPattern) {
			t.Errorf("Compile(%q): want ErrBadPattern, got %v", bad, err)
		}
	}
}

func TestSwapWithExcludes(t *testing.T) {
	prod, prodDir, stag, stagDir := roots(t)
	site(t, prodDir, stagDir)
	fill(t, prod, stag, 7)
	ex, _ := Compile([]string{"wp-config.php", ".env", "public/wp-content/uploads/", "/php/00-panel.ini"})
	var log []string
	if err := Swap(prod, 7, ex, func(s string) { log = append(log, s) }); err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		".panel-deploy/home/x=deploy",
		".panel-wp-setup.json=prod-setup",
		"php/00-panel.ini=memory_limit=512M",
		"public/index.php=nieuw",
		"public/nieuw.txt=nieuw",
		"public/wp-content/uploads/2026/foto.jpg=nieuwe-bestelling",
		"wp-config.php=<?php // productie-db",
	}, "\n")
	if got := tree(t, prodDir); got != want {
		t.Fatalf("na swap:\n%s\nwant:\n%s", got, want)
	}
	if ok, _ := Swapped(prod, 7); !ok {
		t.Fatal("niet swapped")
	}
	// Oude versie staat nog klaar tot Finish.
	if read(prodDir, ".panel-publish-7/old/public/oud-alleen.txt") != "weg" {
		t.Fatal("oude versie niet bewaard")
	}
	if err := Finish(prod, 7); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(prodDir, ".panel-publish-7")); !os.IsNotExist(err) {
		t.Fatal("werkmap niet opgeruimd")
	}
	if len(log) != 3 { // .env bestaat niet in productie: niets te bewaren, en de staging-versie komt ook niet mee
		t.Fatalf("log: %v", log)
	}
}

func TestRollbackAfterSwap(t *testing.T) {
	prod, prodDir, stag, stagDir := roots(t)
	site(t, prodDir, stagDir)
	_ = os.Symlink("public/index.php", filepath.Join(prodDir, "link"))
	before := tree(t, prodDir)
	fill(t, prod, stag, 8)
	ex, _ := Compile([]string{"wp-config.php", "public/wp-content/uploads/"})
	if err := Swap(prod, 8, ex, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if tree(t, prodDir) == before {
		t.Fatal("swap deed niets")
	}
	if err := Rollback(prod, 8); err != nil {
		t.Fatal(err)
	}
	if got := tree(t, prodDir); got != before {
		t.Fatalf("na rollback:\n%s\nwant:\n%s", got, before)
	}
	if _, err := os.Stat(filepath.Join(prodDir, ".panel-publish-8")); !os.IsNotExist(err) {
		t.Fatal("werkmap niet opgeruimd")
	}
	// Idempotent.
	if err := Rollback(prod, 8); err != nil {
		t.Fatal(err)
	}
}

func TestRollbackBeforeSwapOnlyCleansUp(t *testing.T) {
	prod, prodDir, stag, stagDir := roots(t)
	site(t, prodDir, stagDir)
	before := tree(t, prodDir)
	fill(t, prod, stag, 9)
	if err := Rollback(prod, 9); err != nil {
		t.Fatal(err)
	}
	if got := tree(t, prodDir); got != before {
		t.Fatalf("rollback zonder swap veranderde productie:\n%s", got)
	}
}

// Een mislukte wissel (hier: een uitgesloten pad dat niet terug kan) zet alles terug.
func TestSwapFailureRestores(t *testing.T) {
	prod, prodDir, stag, stagDir := roots(t)
	site(t, prodDir, stagDir)
	before := tree(t, prodDir)
	fill(t, prod, stag, 10)
	// Werkmap kapot maken: state.json wordt een map, dan faalt het opslaan van de toestand niet,
	// maar we laten "old" al bestaan als bestand zodat MkdirAll faalt.
	write(t, prodDir, ".panel-publish-10/old", "in de weg")
	if err := Swap(prod, 10, nil, func(string) {}); err == nil {
		t.Fatal("verwacht een fout")
	}
	if got := tree(t, prodDir); got != before {
		t.Fatalf("na mislukte swap:\n%s\nwant:\n%s", got, before)
	}
}

func TestSwapNotPrepared(t *testing.T) {
	prod, _, _, _ := roots(t)
	if err := Swap(prod, 1, nil, func(string) {}); !errors.Is(err, ErrNotPrepared) {
		t.Fatalf("got %v", err)
	}
}

// Uitgesloten pad waar de nieuwe versie een bestand heeft op de plek van een map.
func TestExcludeReplacesBlockingFile(t *testing.T) {
	prod, prodDir, stag, stagDir := roots(t)
	write(t, prodDir, "data/keep/a.txt", "prod")
	write(t, stagDir, "data", "nu een bestand")
	fill(t, prod, stag, 11)
	ex, _ := Compile([]string{"data/keep/"})
	if err := Swap(prod, 11, ex, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if read(prodDir, "data/keep/a.txt") != "prod" {
		t.Fatal(tree(t, prodDir))
	}
	if err := Rollback(prod, 11); err != nil {
		t.Fatal(err)
	}
	if got := tree(t, prodDir); got != "data/keep/a.txt=prod" {
		t.Fatal(got)
	}
}
