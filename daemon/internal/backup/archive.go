package backup

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/klauspost/compress/zstd"
)

// DumpDir is de map in het archief met database-dumps.
const DumpDir = "_databases"

// countWriter telt bytes.
type countWriter struct{ n atomic.Int64 }

func (c *countWriter) Write(p []byte) (int, error) { c.n.Add(int64(len(p))); return len(p), nil }

// zeroPad schrijft n nullen (als een bestand tijdens het lezen korter werd).
func zeroPad(w io.Writer, n int64) error {
	buf := make([]byte, 32<<10)
	for n > 0 {
		k := int64(len(buf))
		if n < k {
			k = n
		}
		if _, err := w.Write(buf[:k]); err != nil {
			return err
		}
		n -= k
	}
	return nil
}

// measure telt de bytes van de bestanden die in het archief komen.
func measure(ctx context.Context, root *os.Root, ig *Ignore) int64 {
	var total int64
	_ = fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil || p == "." {
			return nil
		}
		if p == DumpDir || ig.Match(p) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// writeTar schrijft de inhoud van root (zonder ignore-treffers) en de dumps in dumpDir
// (onder _databases/) als tar naar tw. read telt de gelezen bestandsbytes.
func writeTar(ctx context.Context, tw *tar.Writer, root *os.Root, ig *Ignore, dumpDir string, read *atomic.Int64) error {
	fsys := root.FS()
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil // verdween tijdens de backup
			}
			return err
		}
		if p == "." {
			return nil
		}
		if p == DumpDir || ig.Match(p) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		switch {
		case d.IsDir():
			info, err := d.Info()
			if err != nil {
				return nil
			}
			h, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			h.Name = p + "/"
			clean(h)
			return tw.WriteHeader(h)
		case d.Type()&fs.ModeSymlink != 0:
			info, err := d.Info()
			if err != nil {
				return nil
			}
			link, err := fs.ReadLink(fsys, p)
			if err != nil {
				return nil
			}
			h, err := tar.FileInfoHeader(info, link)
			if err != nil {
				return err
			}
			h.Name = p
			clean(h)
			return tw.WriteHeader(h)
		case d.Type().IsRegular():
			f, err := root.Open(p)
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return fmt.Errorf("%s: %w", p, err)
			}
			defer f.Close()
			info, err := f.Stat()
			if err != nil || !info.Mode().IsRegular() {
				return nil
			}
			h, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			h.Name = p
			clean(h)
			if err := tw.WriteHeader(h); err != nil {
				return err
			}
			n, err := io.Copy(tw, io.LimitReader(&countReader{r: f, n: read}, h.Size))
			if err != nil {
				return fmt.Errorf("%s: %w", p, err)
			}
			if n < h.Size {
				return zeroPad(tw, h.Size-n)
			}
			return nil
		}
		return nil // sockets, fifo's, apparaten
	})
	if err != nil {
		return err
	}
	if dumpDir == "" {
		return nil
	}
	ents, err := os.ReadDir(dumpDir)
	if err != nil {
		return err
	}
	if len(ents) == 0 {
		return nil
	}
	if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: DumpDir + "/", Mode: 0o700}); err != nil {
		return err
	}
	for _, e := range ents {
		if !e.Type().IsRegular() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		f, err := os.Open(filepath.Join(dumpDir, e.Name()))
		if err != nil {
			return err
		}
		info, err := f.Stat()
		if err == nil {
			err = tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: DumpDir + "/" + e.Name(), Mode: 0o600, Size: info.Size(), ModTime: info.ModTime()})
		}
		if err == nil {
			_, err = io.Copy(tw, f)
		}
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

type countReader struct {
	r io.Reader
	n *atomic.Int64
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

func clean(h *tar.Header) {
	h.Uname, h.Gname = "", ""
	h.Format = tar.FormatPAX
}

// compressTar zstd-comprimeert wat fill naar de tar schrijft naar w.
func compressTar(w io.Writer, fill func(tw *tar.Writer) error) error {
	zw, err := zstd.NewWriter(w, zstd.WithEncoderConcurrency(2))
	if err != nil {
		return err
	}
	tw := tar.NewWriter(zw)
	if err := fill(tw); err != nil {
		_ = zw.Close()
		return err
	}
	if err := tw.Close(); err != nil {
		_ = zw.Close()
		return err
	}
	return zw.Close()
}

// ErrBadArchive: het archief bevat iets onveiligs of is beschadigd.
var ErrBadArchive = errors.New("invalid backup archive")

// extract pakt een tar.zst uit in dst (data) en dumps (de map _databases). Alles wat
// wordt aangemaakt krijgt eigenaar uid:gid. dst is een os.Root: paden kunnen er niet uit.
func extract(ctx context.Context, r io.Reader, dst, dumps *os.Root, uid, gid int) error {
	zr, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(2))
	if err != nil {
		return err
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadArchive, err)
		}
		name := path.Clean(strings.TrimPrefix(h.Name, "./"))
		if name == "." {
			continue
		}
		if path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
			return fmt.Errorf("%w: unsafe path %q", ErrBadArchive, h.Name)
		}
		if name == DumpDir || strings.HasPrefix(name, DumpDir+"/") {
			base := path.Base(name)
			if h.Typeflag != tar.TypeReg || path.Dir(name) != DumpDir || !strings.HasSuffix(base, ".sql") {
				continue
			}
			if err := writeFile(dumps, base, tr, 0o600, uid, gid); err != nil {
				return err
			}
			continue
		}
		mode := fs.FileMode(h.Mode) & 0o777
		switch h.Typeflag {
		case tar.TypeDir:
			if err := dst.MkdirAll(name, 0o755); err != nil {
				return err
			}
			if err := dst.Lchown(name, uid, gid); err != nil {
				return err
			}
			if err := dst.Chmod(name, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := mkParent(dst, name, uid, gid); err != nil {
				return err
			}
			if err := writeFile(dst, name, tr, mode, uid, gid); err != nil {
				return err
			}
			_ = dst.Chtimes(name, h.ModTime, h.ModTime)
		case tar.TypeSymlink:
			if err := mkParent(dst, name, uid, gid); err != nil {
				return err
			}
			if err := dst.Symlink(h.Linkname, name); err != nil {
				return err
			}
			if err := dst.Lchown(name, uid, gid); err != nil {
				return err
			}
		}
	}
	// Rest van de stroom (padding, zstd-eindframe) lezen, zodat de hash alles ziet.
	_, err = io.Copy(io.Discard, zr)
	return err
}

func mkParent(root *os.Root, name string, uid, gid int) error {
	dir := path.Dir(name)
	if dir == "." {
		return nil
	}
	parts := strings.Split(dir, "/")
	for i := range parts {
		p := strings.Join(parts[:i+1], "/")
		if _, err := root.Lstat(p); err == nil {
			continue
		}
		if err := root.Mkdir(p, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if err := root.Lchown(p, uid, gid); err != nil {
			return err
		}
	}
	return nil
}

func writeFile(root *os.Root, name string, r io.Reader, mode fs.FileMode, uid, gid int) error {
	f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if err == nil {
		err = f.Chown(uid, gid)
	}
	if err == nil {
		err = f.Chmod(mode)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
