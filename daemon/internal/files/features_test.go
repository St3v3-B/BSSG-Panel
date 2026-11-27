package files

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/klauspost/compress/gzip"
)

func hitPaths(res SearchResult) []string {
	var out []string
	for _, h := range res.Results {
		out = append(out, h.Entry.Path)
	}
	sort.Strings(out)
	return out
}

func TestSearchByName(t *testing.T) {
	r, outside := setup(t)
	must(t, os.WriteFile(filepath.Join(outside, "README-buiten.txt"), []byte("x"), 0o644))
	must(t, os.MkdirAll(filepath.Join(r.Dir, "plugins", "Essentials"), 0o755))
	must(t, os.WriteFile(filepath.Join(r.Dir, "plugins", "Essentials", "config.yml"), []byte("a: 1\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(r.Dir, "plugins", "essx.jar"), []byte("jar"), 0o644))

	res, err := r.Search(context.Background(), SearchOptions{Dir: "/", Query: "ESS"})
	must(t, err)
	if got := hitPaths(res); strings.Join(got, ",") != "/plugins/Essentials,/plugins/essx.jar" || res.Truncated || res.TimedOut {
		t.Fatalf("naam: %v %+v", got, res)
	}
	// Glob.
	res, err = r.Search(context.Background(), SearchOptions{Dir: "/", Query: "*.yml"})
	must(t, err)
	if got := hitPaths(res); len(got) != 1 || got[0] != "/plugins/Essentials/config.yml" {
		t.Fatalf("glob: %v", got)
	}
	// Symlinks worden op naam gevonden maar nooit gevolgd: niets van buiten.
	res, err = r.Search(context.Background(), SearchOptions{Dir: "/", Query: "readme"})
	must(t, err)
	if got := hitPaths(res); strings.Join(got, ",") != "/readme.txt" {
		t.Fatalf("symlink gevolgd? %v", got)
	}
	res, err = r.Search(context.Background(), SearchOptions{Dir: "/", Query: "uit"})
	must(t, err)
	if len(res.Results) != 1 || !res.Results[0].Entry.IsSymlink {
		t.Fatalf("symlink op naam: %+v", res.Results)
	}
	// Startmap via symlink naar buiten of met .. : geweigerd.
	if _, err := r.Search(context.Background(), SearchOptions{Dir: "/uit", Query: "secret"}); !errors.Is(err, ErrEscape) {
		t.Fatalf("start via symlink: %v", err)
	}
	if _, err := r.Search(context.Background(), SearchOptions{Dir: "/../outside", Query: "secret"}); !errors.Is(err, ErrBadPath) {
		t.Fatalf("start via ..: %v", err)
	}
	if _, err := r.Search(context.Background(), SearchOptions{Dir: "/", Query: "  "}); !errors.Is(err, ErrBadPath) {
		t.Fatalf("lege zoekterm: %v", err)
	}
	if _, err := r.Search(context.Background(), SearchOptions{Dir: "/", Query: "[a"}); !errors.Is(err, ErrBadPath) {
		t.Fatalf("kapotte glob: %v", err)
	}
	// Submap als start.
	res, err = r.Search(context.Background(), SearchOptions{Dir: "/plugins/Essentials", Query: "ess"})
	must(t, err)
	if len(res.Results) != 0 {
		t.Fatalf("buiten de startmap gezocht: %v", hitPaths(res))
	}
}

func TestSearchLimitAndTimeout(t *testing.T) {
	r, _ := setup(t)
	must(t, os.MkdirAll(filepath.Join(r.Dir, "veel"), 0o755))
	for i := range 30 {
		must(t, os.WriteFile(filepath.Join(r.Dir, "veel", fmt.Sprintf("log-%02d.txt", i)), []byte("fout op regel\n"), 0o644))
	}
	res, err := r.Search(context.Background(), SearchOptions{Dir: "/", Query: "log-", Limit: 10})
	must(t, err)
	if len(res.Results) != 10 || !res.Truncated {
		t.Fatalf("limiet: %d %v", len(res.Results), res.Truncated)
	}
	res, err = r.Search(context.Background(), SearchOptions{Dir: "/", Query: "log-", Limit: 1_000_000})
	must(t, err)
	if len(res.Results) != 30 || res.Truncated {
		t.Fatalf("max-limiet: %d", len(res.Results))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, err = r.Search(ctx, SearchOptions{Dir: "/", Query: "log-"})
	must(t, err)
	if !res.TimedOut || len(res.Results) != 0 {
		t.Fatalf("timeout: %+v", res)
	}
}

func TestSearchContent(t *testing.T) {
	r, outside := setup(t)
	must(t, os.WriteFile(filepath.Join(outside, "buiten.txt"), []byte("NAALD buiten\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(r.Dir, "a.properties"), []byte("motd=hoi\nserver-port=25565\n# naald hier\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(r.Dir, "sub", "bin.dat"), append([]byte("naald\x00"), 1, 2, 3), 0o644))
	must(t, os.WriteFile(filepath.Join(r.Dir, "groot.log"), append(bytes.Repeat([]byte("x"), SearchMaxFileBytes), []byte("naald")...), 0o644))
	long := strings.Repeat("a", 1000) + "NAALD" + strings.Repeat("b", 1000)
	must(t, os.WriteFile(filepath.Join(r.Dir, "sub", "lang.txt"), []byte(long+"\n"), 0o644))
	must(t, os.Symlink(filepath.Join(outside, "buiten.txt"), filepath.Join(r.Dir, "link.txt")))

	res, err := r.Search(context.Background(), SearchOptions{Dir: "/", Query: "Naald", Content: true})
	must(t, err)
	got := hitPaths(res)
	if strings.Join(got, ",") != "/a.properties,/sub/lang.txt" {
		t.Fatalf("inhoud: %v", got)
	}
	for _, h := range res.Results {
		switch h.Entry.Path {
		case "/a.properties":
			if len(h.Matches) != 1 || h.Matches[0].Line != 3 || h.Matches[0].Text != "# naald hier" {
				t.Fatalf("match: %+v", h.Matches)
			}
		case "/sub/lang.txt":
			m := h.Matches[0].Text
			if !strings.Contains(m, "NAALD") || len([]rune(m)) > searchMaxLineRunes+2 || !strings.HasPrefix(m, "…") {
				t.Fatalf("snippet: %q", m)
			}
		}
	}
}

func readTarGz(t *testing.T, b []byte) map[string]string {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(b))
	must(t, err)
	tr := tar.NewReader(gz)
	out := map[string]string{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		must(t, err)
		switch h.Typeflag {
		case tar.TypeReg:
			c, _ := io.ReadAll(tr)
			out[h.Name] = string(c)
		case tar.TypeSymlink:
			out[h.Name] = "-> " + h.Linkname
		case tar.TypeDir:
			out[h.Name] = "dir"
		}
	}
}

func readZip(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	must(t, err)
	out := map[string]string{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			out[f.Name] = "dir"
			continue
		}
		rc, err := f.Open()
		must(t, err)
		c, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(c)
	}
	return out
}

func TestStreamArchive(t *testing.T) {
	r, _ := setup(t)
	must(t, os.MkdirAll(filepath.Join(r.Dir, "plugins", "cfg"), 0o755))
	must(t, os.WriteFile(filepath.Join(r.Dir, "plugins", "a.jar"), []byte("jar"), 0o644))
	must(t, os.WriteFile(filepath.Join(r.Dir, "plugins", "cfg", "c.yml"), []byte("k: v\n"), 0o644))
	must(t, os.Symlink("../../uit", filepath.Join(r.Dir, "plugins", "cfg", "ontsnap")))

	sel, err := r.PrepareArchive("/", []string{"/plugins", "readme.txt", "/sub"})
	must(t, err)
	if sel.Name != "files" {
		t.Fatal(sel.Name)
	}
	var buf bytes.Buffer
	must(t, r.StreamArchive(&buf, sel, FormatTarGz))
	got := readTarGz(t, buf.Bytes())
	want := map[string]string{
		"plugins/": "dir", "plugins/a.jar": "jar", "plugins/cfg/": "dir", "plugins/cfg/c.yml": "k: v\n",
		"plugins/cfg/ontsnap": "-> ../../uit", "readme.txt": "hallo\n", "sub/": "dir", "sub/binnen": "-> ../readme.txt",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("tar.gz:\n%v\nwil\n%v", got, want)
	}
	for k := range got {
		if strings.Contains(k, "secret") {
			t.Fatal("inhoud van buiten in het archief")
		}
	}

	// Zip, relatief aan /plugins: symlinks worden overgeslagen, nooit gevolgd.
	sel, err = r.PrepareArchive("/plugins", []string{"cfg", "a.jar"})
	must(t, err)
	if sel.Name != "plugins" {
		t.Fatal(sel.Name)
	}
	buf.Reset()
	must(t, r.StreamArchive(&buf, sel, FormatZip))
	got = readZip(t, buf.Bytes())
	want = map[string]string{"a.jar": "jar", "cfg/": "dir", "cfg/c.yml": "k: v\n"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("zip: %v", got)
	}

	// De hele root als zip: de symlinks naar buiten (uit, passwd) leveren niets op.
	sel, err = r.PrepareArchive("/", []string{"/"})
	must(t, err)
	buf.Reset()
	must(t, r.StreamArchive(&buf, sel, FormatZip))
	got = readZip(t, buf.Bytes())
	if got["readme.txt"] != "hallo\n" || got["plugins/a.jar"] != "jar" {
		t.Fatalf("root-zip: %v", got)
	}
	for k, v := range got {
		if strings.HasPrefix(k, "uit") || k == "passwd" || strings.Contains(v, "geheim") || strings.Contains(v, "root:") {
			t.Fatalf("ontsnapt via symlink: %s", k)
		}
	}

	// Eén map: voorgestelde naam is die map.
	sel, err = r.PrepareArchive("/", []string{"/plugins/cfg"})
	must(t, err)
	if sel.Name != "cfg" {
		t.Fatal(sel.Name)
	}

	// Validatie vooraf.
	for _, bad := range [][]string{{"/uit/secret.txt"}, {"/../outside"}, {"/bestaat-niet"}, {}} {
		if _, err := r.PrepareArchive("/", bad); err == nil {
			t.Fatalf("%v geaccepteerd", bad)
		}
	}
	if _, err := r.PrepareArchive("/uit", []string{"secret.txt"}); err == nil {
		t.Fatal("root via symlink geaccepteerd")
	}
	sel, _ = r.PrepareArchive("/", []string{"/readme.txt"})
	if err := r.StreamArchive(io.Discard, sel, "rar"); !errors.Is(err, ErrBadFormat) {
		t.Fatal(err)
	}
}

func TestParseMode(t *testing.T) {
	for in, want := range map[string]uint32{"644": 0o644, "0755": 0o755, "000": 0, "777": 0o777} {
		got, err := ParseMode(in, false)
		if err != nil || got != want {
			t.Errorf("ParseMode(%q) = %o, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "64", "12345", "888", "4755", "1777", "2755", "abc", "-644", "+644"} {
		if _, err := ParseMode(in, false); !errors.Is(err, ErrBadMode) {
			t.Errorf("ParseMode(%q) zonder speciale bits: %v", in, err)
		}
	}
	if m, err := ParseMode("2775", true); err != nil || m != 0o2775 {
		t.Fatal(m, err)
	}
}

func perm(t *testing.T, p string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(p)
	must(t, err)
	return fi.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky)
}

func TestSetMode(t *testing.T) {
	r, outside := setup(t)
	must(t, os.MkdirAll(filepath.Join(r.Dir, "web", "deep"), 0o755))
	must(t, os.WriteFile(filepath.Join(r.Dir, "web", "index.php"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(r.Dir, "web", "deep", "x.sh"), []byte("x"), 0o644))
	must(t, os.Symlink(outside, filepath.Join(r.Dir, "web", "naarbuiten")))
	secret := filepath.Join(outside, "secret.txt")
	before := perm(t, secret)
	beforeDir := perm(t, outside)

	n, err := r.SetMode("/readme.txt", 0o600, 0o700, false)
	must(t, err)
	if n != 1 || perm(t, filepath.Join(r.Dir, "readme.txt")) != 0o600 {
		t.Fatal(n, perm(t, filepath.Join(r.Dir, "readme.txt")))
	}
	n, err = r.SetMode("/web", 0o640, 0o750, true)
	must(t, err)
	if n != 4 {
		t.Fatalf("aantal: %d", n)
	}
	if perm(t, filepath.Join(r.Dir, "web")) != 0o750 || perm(t, filepath.Join(r.Dir, "web", "deep", "x.sh")) != 0o640 {
		t.Fatal("recursief niet toegepast")
	}
	// Speciale bits komen er alleen in als ParseMode ze toeliet.
	_, err = r.SetMode("/web/index.php", 0o2755, 0o755, false)
	must(t, err)
	if perm(t, filepath.Join(r.Dir, "web", "index.php")) != os.ModeSetgid|0o755 {
		t.Fatal(perm(t, filepath.Join(r.Dir, "web", "index.php")))
	}
	// Symlinks naar buiten: niet gevolgd, het doel blijft gelijk.
	for _, p := range []string{"/uit", "/passwd", "/web/naarbuiten"} {
		n, err := r.SetMode(p, 0o777, 0o777, true)
		if err != nil || n != 0 {
			t.Fatalf("%s: %d %v", p, n, err)
		}
	}
	if _, err := r.SetMode("/uit/secret.txt", 0o777, 0o777, false); !errors.Is(err, ErrEscape) {
		t.Fatalf("via symlink: %v", err)
	}
	if _, err := r.SetMode("/../outside/secret.txt", 0o777, 0o777, false); !errors.Is(err, ErrBadPath) {
		t.Fatalf("via ..: %v", err)
	}
	if _, err := r.SetMode("/", 0o777, 0o777, true); !errors.Is(err, ErrBadPath) {
		t.Fatalf("root: %v", err)
	}
	if _, err := r.SetMode("/weg", 0o644, 0o755, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bestaat niet: %v", err)
	}
	if perm(t, secret) != before || perm(t, outside) != beforeDir {
		t.Fatal("rechten buiten de root gewijzigd")
	}
}
