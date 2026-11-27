package files

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestExportImportTar(t *testing.T) {
	src, _ := setup(t)
	must(t, os.WriteFile(filepath.Join(src.Dir, "sub", "diep.bin"), bytes.Repeat([]byte{7}, 100000), 0o600))
	var buf bytes.Buffer
	must(t, src.ExportTar(&buf))

	dst := New(filepath.Join(t.TempDir(), "data"), os.Getuid(), os.Getgid())
	must(t, os.MkdirAll(dst.Dir, 0o755))
	must(t, dst.ImportTar(bytes.NewReader(buf.Bytes()), Unlimited))

	b, err := os.ReadFile(filepath.Join(dst.Dir, "readme.txt"))
	if err != nil || string(b) != "hallo\n" {
		t.Fatalf("readme: %q %v", b, err)
	}
	if st, err := os.Stat(filepath.Join(dst.Dir, "sub", "diep.bin")); err != nil || st.Size() != 100000 {
		t.Fatalf("diep.bin: %v %v", st, err)
	}
	// Symlinks blijven symlinks (ook die naar buiten de root: ze worden nooit gevolgd).
	if l, err := os.Readlink(filepath.Join(dst.Dir, "sub", "binnen")); err != nil || l != "../readme.txt" {
		t.Fatalf("symlink: %q %v", l, err)
	}
	if _, err := os.Lstat(filepath.Join(dst.Dir, "passwd")); err != nil {
		t.Fatalf("passwd-symlink: %v", err)
	}
	if l, err := os.Readlink(filepath.Join(dst.Dir, "uit")); err != nil || l == "" {
		t.Fatalf("uit-symlink: %q %v", l, err)
	}
}

func TestImportTarBudget(t *testing.T) {
	src, _ := setup(t)
	must(t, os.WriteFile(filepath.Join(src.Dir, "groot.bin"), bytes.Repeat([]byte{1}, 50000), 0o644))
	var buf bytes.Buffer
	must(t, src.ExportTar(&buf))
	dst := New(t.TempDir(), os.Getuid(), os.Getgid())
	if err := dst.ImportTar(bytes.NewReader(buf.Bytes()), 1000); !errors.Is(err, ErrDiskFull) {
		t.Fatalf("verwacht ErrDiskFull, kreeg %v", err)
	}
}

func TestImportTarTruncated(t *testing.T) {
	src, _ := setup(t)
	must(t, os.WriteFile(filepath.Join(src.Dir, "groot.bin"), bytes.Repeat([]byte{1}, 50000), 0o644))
	var buf bytes.Buffer
	must(t, src.ExportTar(&buf))
	dst := New(t.TempDir(), os.Getuid(), os.Getgid())
	if err := dst.ImportTar(bytes.NewReader(buf.Bytes()[:buf.Len()/2]), Unlimited); err == nil {
		t.Fatal("afgekapte tar moet een fout geven")
	}
}
