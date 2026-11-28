package files

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
	"golang.org/x/sys/unix"
)

// Budget is het aantal bytes dat nog geschreven mag worden (< 0 = onbeperkt).
type Budget int64

// Unlimited is een onbeperkt budget.
const Unlimited Budget = -1

// LimitWriter telt geschreven bytes en geeft ErrDiskFull boven het budget.
type LimitWriter struct {
	W       io.Writer
	Budget  Budget
	Written int64
}

func (l *LimitWriter) Write(p []byte) (int, error) {
	if l.Budget >= 0 && l.Written+int64(len(p)) > int64(l.Budget) {
		return 0, ErrDiskFull
	}
	n, err := l.W.Write(p)
	l.Written += int64(n)
	return n, mapErr(err)
}

// Compress maakt een tar.gz in de map root met de opgegeven paden (relatief aan root of
// absoluut binnen de serverdata). Geeft de Entry van het archief.
func (r *Root) Compress(rootDir string, paths []string, budget Budget) (Entry, error) {
	base, err := Clean(rootDir)
	if err != nil {
		return Entry{}, err
	}
	var rels []string
	for _, p := range paths {
		var rel string
		if strings.HasPrefix(p, "/") {
			rel, err = Clean(p)
		} else {
			rel, err = Clean(APIPath(base) + "/" + p)
		}
		if err != nil {
			return Entry{}, err
		}
		if rel == "." {
			return Entry{}, ErrBadPath
		}
		rels = append(rels, rel)
	}
	name := "archive-" + time.Now().In(time.Local).Format("2006-01-02_15-04-05") + ".tar.gz"
	target := path.Join(APIPath(base), name)
	f, err := r.Open(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return Entry{}, err
	}
	lw := &LimitWriter{W: f, Budget: budget}
	gz := gzip.NewWriter(lw)
	tw := tar.NewWriter(gz)
	werr := func() error {
		root, err := r.rootFD()
		if err != nil {
			return err
		}
		defer unix.Close(root)
		targetRel, _ := Clean(target)
		for _, rel := range rels {
			dir, name := path.Split(rel)
			dir = strings.TrimSuffix(dir, "/")
			if dir == "" {
				dir = "."
			}
			pfd, err := openBeneath(root, dir, unix.O_PATH|unix.O_DIRECTORY, 0)
			if err != nil {
				return err
			}
			arcName := strings.TrimPrefix(strings.TrimPrefix(rel, base+"/"), "./")
			if base == "." {
				arcName = rel
			}
			err = addTree(tw, pfd, name, arcName, targetRel, rel, 0)
			unix.Close(pfd)
			if err != nil {
				return err
			}
		}
		if err := tw.Close(); err != nil {
			return err
		}
		return gz.Close()
	}()
	cerr := f.Close()
	if werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = r.Remove(target)
		return Entry{}, werr
	}
	return r.Stat(target)
}

func addTree(tw *tar.Writer, dirfd int, name, arcName, skipRel, rel string, depth int) error {
	return walkTree(tarSink{tw}, dirfd, name, arcName, skipRel, rel, depth)
}

// ArchiveKind geeft het formaat op basis van de naam, of "".
func ArchiveKind(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, ".zip"):
		return "zip"
	case strings.HasSuffix(n, ".tar.gz"), strings.HasSuffix(n, ".tgz"):
		return "tar.gz"
	case strings.HasSuffix(n, ".tar.zst"):
		return "tar.zst"
	case strings.HasSuffix(n, ".tar"):
		return "tar"
	}
	return ""
}

// Decompress pakt een archief uit in zijn eigen map. Hardlinks en speciale bestanden
// worden overgeslagen; paden buiten de map worden geweigerd.
func (r *Root) Decompress(p string, budget Budget) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	kind := ArchiveKind(rel)
	if kind == "" {
		return ErrBadFormat
	}
	f, fi, err := r.OpenRead(p)
	if err != nil {
		return err
	}
	defer f.Close()
	dir := path.Dir(rel)
	x := &extractor{r: r, dir: dir, budget: budget}
	switch kind {
	case "zip":
		zr, err := zip.NewReader(f, fi.Size())
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadFormat, err)
		}
		for _, zf := range zr.File {
			if err := x.zipEntry(zf); err != nil {
				return err
			}
		}
		return nil
	case "tar.gz":
		gz, err := gzip.NewReader(f)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadFormat, err)
		}
		defer gz.Close()
		return x.tar(gz)
	case "tar.zst":
		zr, err := zstd.NewReader(f)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadFormat, err)
		}
		defer zr.Close()
		return x.tar(zr)
	default:
		return x.tar(f)
	}
}

type extractor struct {
	r       *Root
	dir     string
	budget  Budget
	written int64
}

func (x *extractor) target(name string) (string, bool) {
	rel, err := Clean(name)
	if err != nil || rel == "." {
		return "", false
	}
	if x.dir != "." {
		rel = x.dir + "/" + rel
	}
	return rel, true
}

func (x *extractor) file(rel string, mode os.FileMode, src io.Reader) error {
	if err := x.r.MkdirAll(path.Dir(rel)); err != nil {
		return err
	}
	_ = x.r.RemoveAll(APIPath(rel)) // bestaand bestand of symlink vervangen, nooit volgen
	f, err := x.r.Open(APIPath(rel), os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode.Perm()&0o755|0o600)
	if err != nil {
		return err
	}
	rest := x.budget
	if rest >= 0 {
		rest -= Budget(x.written)
		if rest < 0 {
			rest = 0
		}
	}
	lw := &LimitWriter{W: f, Budget: rest}
	_, err = io.Copy(lw, src)
	x.written += lw.Written
	cerr := f.Close()
	if err == nil {
		err = cerr
	}
	return err
}

func (x *extractor) tar(rd io.Reader) error {
	tr := tar.NewReader(rd)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadFormat, err)
		}
		rel, ok := x.target(h.Name)
		if !ok {
			continue
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := x.r.MkdirAll(rel); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := x.file(rel, os.FileMode(h.Mode), tr); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := x.r.MkdirAll(path.Dir(rel)); err != nil {
				return err
			}
			_ = x.r.RemoveAll(APIPath(rel))
			if err := x.r.Symlink(h.Linkname, APIPath(rel)); err != nil {
				return err
			}
		}
	}
}

func (x *extractor) zipEntry(zf *zip.File) error {
	rel, ok := x.target(zf.Name)
	if !ok {
		return nil
	}
	mode := zf.Mode()
	switch {
	case mode.IsDir() || strings.HasSuffix(zf.Name, "/"):
		return x.r.MkdirAll(rel)
	case mode&os.ModeSymlink != 0:
		return nil
	case mode.IsRegular():
		rc, err := zf.Open()
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadFormat, err)
		}
		defer rc.Close()
		perm := mode.Perm()
		if perm == 0 {
			perm = 0o644
		}
		return x.file(rel, perm, rc)
	}
	return nil
}

// ExportTar schrijft de hele datamap als niet-gecomprimeerde tar (voor het verplaatsen van een
// server naar een andere node). Symlinks blijven symlinks; sockets en devices worden overgeslagen.
func (r *Root) ExportTar(w io.Writer) error { return r.ExportTarSkip(w, nil) }

// ExportTarSkip is ExportTar zonder de namen op het hoogste niveau waarvoor skip true geeft.
func (r *Root) ExportTarSkip(w io.Writer, skip func(name string) bool) error {
	all, err := readNames(r.Dir)
	if err != nil {
		return err
	}
	names := all[:0]
	for _, n := range all {
		if skip == nil || !skip(n) {
			names = append(names, n)
		}
	}
	root, err := r.rootFD()
	if err != nil {
		return err
	}
	defer unix.Close(root)
	tw := tar.NewWriter(w)
	for _, n := range names {
		if err := addTree(tw, root, n, n, "", n, 0); err != nil {
			return err
		}
	}
	return tw.Close()
}

func readNames(dir string) ([]string, error) {
	d, err := os.Open(dir)
	if err != nil {
		return nil, mapErr(err)
	}
	defer d.Close()
	return d.Readdirnames(-1)
}

// ImportTar pakt een tar-stroom (zoals ExportTar maakt) uit in de datamap, met dezelfde
// veiligheidsregels als Decompress.
func (r *Root) ImportTar(rd io.Reader, budget Budget) error {
	x := &extractor{r: r, dir: ".", budget: budget}
	return x.tar(rd)
}

// ImportTarInto is ImportTar, maar pakt uit in de map dir (relatief, moet al bestaan) binnen de
// datamap. Alle bewerkingen lopen via deze root (RESOLVE_BENEATH): ook een map die tijdens het
// uitpakken door een symlink vervangen wordt, brengt niets buiten de serverdata.
func (r *Root) ImportTarInto(dir string, rd io.Reader, budget Budget) error {
	rel, err := Clean(dir)
	if err != nil {
		return err
	}
	x := &extractor{r: r, dir: rel, budget: budget}
	return x.tar(rd)
}
