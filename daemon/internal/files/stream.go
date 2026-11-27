package files

import (
	"archive/tar"
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/klauspost/compress/flate"
	"github.com/klauspost/compress/gzip"
	"golang.org/x/sys/unix"
)

// archiveSink schrijft de onderdelen van een archief. walkTree volgt nooit symlinks.
type archiveSink interface {
	dir(name string, st *unix.Stat_t) error
	file(name string, st *unix.Stat_t, f *os.File) error
	symlink(name, target string, st *unix.Stat_t) error
}

// walkTree loopt name (in dirfd) recursief af zonder symlinks te volgen. skipRel wordt
// overgeslagen (het archief zelf bij Compress); sockets en devices ook.
func walkTree(sink archiveSink, dirfd int, name, arcName, skipRel, rel string, depth int) error {
	if depth > 256 {
		return errors.New("te diep genest")
	}
	if rel == skipRel {
		return nil
	}
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return mapErr(err)
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		if err := sink.dir(arcName, &st); err != nil {
			return err
		}
		fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return mapErr(err)
		}
		f := os.NewFile(uintptr(fd), name)
		defer f.Close()
		names, err := f.Readdirnames(-1)
		if err != nil {
			return err
		}
		for _, n := range names {
			if err := walkTree(sink, fd, n, arcName+"/"+n, skipRel, rel+"/"+n, depth+1); err != nil {
				return err
			}
		}
		return nil
	case unix.S_IFLNK:
		buf := make([]byte, 4096)
		n, err := unix.Readlinkat(dirfd, name, buf)
		if err != nil {
			return mapErr(err)
		}
		return sink.symlink(arcName, string(buf[:n]), &st)
	case unix.S_IFREG:
		fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err != nil {
			return mapErr(err)
		}
		f := os.NewFile(uintptr(fd), name)
		defer f.Close()
		// Opnieuw stat via de fd: dat is het bestand dat we echt lezen.
		if err := unix.Fstat(fd, &st); err != nil {
			return err
		}
		return sink.file(arcName, &st, f)
	}
	return nil
}

func modTime(st *unix.Stat_t) time.Time { return time.Unix(st.Mtim.Unix()) }

type tarSink struct{ tw *tar.Writer }

func (s tarSink) hdr(name string, st *unix.Stat_t) *tar.Header {
	return &tar.Header{Name: name, Mode: int64(fileMode(st.Mode).Perm()), ModTime: modTime(st), Uid: 1000, Gid: 1000, Format: tar.FormatPAX}
}

func (s tarSink) dir(name string, st *unix.Stat_t) error {
	h := s.hdr(name+"/", st)
	h.Typeflag = tar.TypeDir
	return s.tw.WriteHeader(h)
}

func (s tarSink) symlink(name, target string, st *unix.Stat_t) error {
	h := s.hdr(name, st)
	h.Typeflag = tar.TypeSymlink
	h.Linkname = target
	return s.tw.WriteHeader(h)
}

func (s tarSink) file(name string, st *unix.Stat_t, f *os.File) error {
	h := s.hdr(name, st)
	h.Typeflag = tar.TypeReg
	h.Size = st.Size
	if err := s.tw.WriteHeader(h); err != nil {
		return err
	}
	_, err := io.CopyN(s.tw, f, st.Size)
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("%s shrank while being archived", name)
	}
	return err
}

// zipSink: symlinks worden overgeslagen (zip-programma's gaan er verschillend mee om).
type zipSink struct{ zw *zip.Writer }

// storeExt: al gecomprimeerd, dus niet nog eens deflaten.
var storeExt = map[string]bool{".jar": true, ".zip": true, ".gz": true, ".tgz": true, ".zst": true, ".xz": true, ".bz2": true,
	".7z": true, ".rar": true, ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".mp3": true, ".ogg": true, ".mp4": true}

func (s zipSink) dir(name string, st *unix.Stat_t) error {
	h := &zip.FileHeader{Name: name + "/", Method: zip.Store, Modified: modTime(st)}
	h.SetMode(fileMode(st.Mode).Perm() | os.ModeDir)
	_, err := s.zw.CreateHeader(h)
	return err
}

func (s zipSink) symlink(string, string, *unix.Stat_t) error { return nil }

func (s zipSink) file(name string, st *unix.Stat_t, f *os.File) error {
	method := zip.Deflate
	if storeExt[strings.ToLower(path.Ext(name))] {
		method = zip.Store
	}
	h := &zip.FileHeader{Name: name, Method: method, Modified: modTime(st)}
	h.SetMode(fileMode(st.Mode).Perm())
	w, err := s.zw.CreateHeader(h)
	if err != nil {
		return err
	}
	_, err = io.CopyN(w, f, st.Size)
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("%s shrank while being archived", name)
	}
	return err
}

// Archiefformaten voor StreamArchive.
const (
	FormatZip   = "zip"
	FormatTarGz = "tar.gz"
)

// ArchiveSelection is een gecontroleerde selectie voor StreamArchive.
type ArchiveSelection struct {
	base string   // map waartegen de namen in het archief relatief zijn
	rels []string // paden (relatief aan de root), "." = de hele root
	// Name is een voorgestelde bestandsnaam zonder extensie.
	Name string
}

// PrepareArchive controleert root en paden (opgeschoond, binnen de root, bestaand) vóórdat er
// iets gestreamd wordt, zodat fouten nog als JSON terug kunnen.
func (r *Root) PrepareArchive(rootDir string, paths []string) (*ArchiveSelection, error) {
	base, err := Clean(rootDir)
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, ErrBadPath
	}
	sel := &ArchiveSelection{base: base}
	seen := map[string]bool{}
	for _, p := range paths {
		var rel string
		if strings.HasPrefix(p, "/") {
			rel, err = Clean(p)
		} else {
			rel, err = Clean(APIPath(base) + "/" + p)
		}
		if err != nil {
			return nil, err
		}
		if seen[rel] {
			continue
		}
		seen[rel] = true
		if rel == "." {
			if _, err := r.StatFollow("/"); err != nil {
				return nil, err
			}
		} else if _, err := r.Lstat(APIPath(rel)); err != nil {
			return nil, err
		}
		sel.rels = append(sel.rels, rel)
	}
	switch {
	case len(sel.rels) == 1 && sel.rels[0] != ".":
		sel.Name = path.Base(sel.rels[0])
	case base != ".":
		sel.Name = path.Base(base)
	default:
		sel.Name = "files"
	}
	return sel, nil
}

// StreamArchive schrijft de selectie als zip of tar.gz naar w, zonder tijdelijk bestand
// (dus zonder schijfruimte van de server te gebruiken). Symlinks worden nooit gevolgd: in
// tar.gz blijven ze symlinks, in zip worden ze overgeslagen.
func (r *Root) StreamArchive(w io.Writer, sel *ArchiveSelection, format string) error {
	var sink archiveSink
	var closeFn func() error
	switch format {
	case FormatZip:
		zw := zip.NewWriter(w)
		zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
			return flate.NewWriter(out, flate.DefaultCompression)
		})
		sink, closeFn = zipSink{zw}, zw.Close
	case FormatTarGz:
		gz, _ := gzip.NewWriterLevel(w, gzip.DefaultCompression)
		tw := tar.NewWriter(gz)
		sink = tarSink{tw}
		closeFn = func() error {
			if err := tw.Close(); err != nil {
				return err
			}
			return gz.Close()
		}
	default:
		return ErrBadFormat
	}
	root, err := r.rootFD()
	if err != nil {
		return err
	}
	defer unix.Close(root)
	for _, rel := range sel.rels {
		if rel == "." {
			fd, err := unix.Openat(root, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
			if err != nil {
				return mapErr(err)
			}
			d := os.NewFile(uintptr(fd), ".")
			names, err := d.Readdirnames(-1)
			if err != nil {
				d.Close()
				return err
			}
			for _, n := range names {
				if err := walkTree(sink, fd, n, n, "", n, 0); err != nil {
					d.Close()
					return err
				}
			}
			d.Close()
			continue
		}
		dir, name := path.Split(rel)
		dir = strings.TrimSuffix(dir, "/")
		if dir == "" {
			dir = "."
		}
		pfd, err := openBeneath(root, dir, unix.O_PATH|unix.O_DIRECTORY, 0)
		if err != nil {
			return err
		}
		arcName := rel
		if sel.base != "." {
			arcName = strings.TrimPrefix(rel, sel.base+"/")
		}
		err = walkTree(sink, pfd, name, arcName, "", rel, 0)
		unix.Close(pfd)
		if err != nil {
			return err
		}
	}
	return closeFn()
}
