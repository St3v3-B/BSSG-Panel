// Package files geeft veilige toegang tot de data-map van één server. Elk pad wordt met
// openat2(RESOLVE_BENEATH) opgelost vanaf een fd van de root, zodat ".." en symlinks
// (ook symlinks die tijdens de bewerking verwisseld worden) nooit buiten de root komen.
package files

import (
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Fouten die de API naar statuscodes vertaalt.
var (
	ErrBadPath   = errors.New("invalid path")
	ErrEscape    = errors.New("pad wijst buiten de serverdata")
	ErrNotFound  = errors.New("file or directory does not exist")
	ErrExists    = errors.New("already exists")
	ErrNotDir    = errors.New("not a directory")
	ErrIsDir     = errors.New("is a directory")
	ErrNotFile   = errors.New("not a regular file")
	ErrDiskFull  = errors.New("disk-limiet bereikt")
	ErrTooLarge  = errors.New("file too large")
	ErrBadFormat = errors.New("unknown archive format")
)

// Root is de data-map van een server. Bestanden die de daemon aanmaakt krijgen UID:GID.
type Root struct {
	Dir      string
	UID, GID int
}

// New maakt een Root.
func New(dir string, uid, gid int) *Root { return &Root{Dir: dir, UID: uid, GID: gid} }

// Clean zet een API-pad ("/plugins/x.jar") om naar een relatief pad ("plugins/x.jar");
// de root zelf is ".". ".." boven de root geeft ErrBadPath.
func Clean(p string) (string, error) {
	if strings.ContainsRune(p, 0) || len(p) > 4096 {
		return "", ErrBadPath
	}
	var parts []string
	for _, c := range strings.Split(strings.ReplaceAll(p, "\\", "/"), "/") {
		switch c {
		case "", ".":
		case "..":
			if len(parts) == 0 {
				return "", ErrBadPath
			}
			parts = parts[:len(parts)-1]
		default:
			if len(c) > 255 {
				return "", ErrBadPath
			}
			parts = append(parts, c)
		}
	}
	if len(parts) == 0 {
		return ".", nil
	}
	return strings.Join(parts, "/"), nil
}

// APIPath zet een relatief pad terug naar de vorm met "/".
func APIPath(rel string) string {
	if rel == "." || rel == "" {
		return "/"
	}
	return "/" + rel
}

func mapErr(err error) error {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return err
	}
	switch errno {
	case unix.ENOENT:
		return ErrNotFound
	case unix.EXDEV, unix.ELOOP:
		return ErrEscape
	case unix.EEXIST, unix.ENOTEMPTY:
		return ErrExists
	case unix.ENOTDIR:
		return ErrNotDir
	case unix.EISDIR:
		return ErrIsDir
	case unix.ENAMETOOLONG, unix.EINVAL:
		return ErrBadPath
	case unix.EDQUOT, unix.ENOSPC:
		return ErrDiskFull
	}
	return err
}

func (r *Root) rootFD() (int, error) {
	fd, err := unix.Open(r.Dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("data-map openen: %w", err)
	}
	return fd, nil
}

const resolve = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS

// openat opent rel (relatief, al opgeschoond) onder de root.
func (r *Root) openat(rel string, flags int, mode uint32) (int, error) {
	root, err := r.rootFD()
	if err != nil {
		return -1, err
	}
	defer unix.Close(root)
	return openBeneath(root, rel, flags, mode)
}

func openBeneath(dirfd int, rel string, flags int, mode uint32) (int, error) {
	how := unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Mode: uint64(mode), Resolve: resolve}
	for {
		fd, err := unix.Openat2(dirfd, rel, &how)
		if err == unix.EINTR || err == unix.EAGAIN {
			continue
		}
		if err != nil {
			return -1, mapErr(err)
		}
		return fd, nil
	}
}

// parent opent de map boven rel en geeft de naam van het laatste deel. rel mag niet de
// root zelf zijn.
func (r *Root) parent(rel string) (int, string, error) {
	if rel == "." || rel == "" {
		return -1, "", ErrBadPath
	}
	dir, name := path.Split(rel)
	if dir == "" {
		dir = "."
	}
	fd, err := r.openat(strings.TrimSuffix(dir, "/"), unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return -1, "", err
	}
	return fd, name, nil
}

// Open opent een bestand voor lezen of schrijven (flags zoals os.OpenFile). Nieuwe
// bestanden krijgen UID:GID.
func (r *Root) Open(p string, flags int, perm os.FileMode) (*os.File, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, err
	}
	if flags&os.O_CREATE != 0 {
		if rel == "." {
			return nil, ErrIsDir
		}
		// Bestond hij al? Dan niet opnieuw chown'en.
		pfd, name, err := r.parent(rel)
		if err != nil {
			return nil, err
		}
		var st unix.Stat_t
		existed := unix.Fstatat(pfd, name, &st, unix.AT_SYMLINK_NOFOLLOW) == nil
		unix.Close(pfd)
		fd, err := r.openat(rel, flags, uint32(perm.Perm()))
		if err != nil {
			return nil, err
		}
		if !existed {
			_ = unix.Fchown(fd, r.UID, r.GID)
		}
		return os.NewFile(uintptr(fd), APIPath(rel)), nil
	}
	fd, err := r.openat(rel, flags, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), APIPath(rel)), nil
}

// OpenRead opent een gewoon bestand om te lezen.
func (r *Root) OpenRead(p string) (*os.File, fs.FileInfo, error) {
	f, err := r.Open(p, os.O_RDONLY, 0)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if fi.IsDir() {
		f.Close()
		return nil, nil, ErrIsDir
	}
	if !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, ErrNotFile
	}
	return f, fi, nil
}

// Entry is het FileEntry-schema uit openapi.yaml.
type Entry struct {
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	IsDirectory bool      `json:"is_directory"`
	IsSymlink   bool      `json:"is_symlink"`
	Size        int64     `json:"size"`
	Mode        string    `json:"mode"`
	MimeType    string    `json:"mime_type"`
	ModifiedAt  time.Time `json:"modified_at"`
}

// Info is een fs.FileInfo voor SFTP.
type Info struct {
	name string
	st   unix.Stat_t
}

func (i *Info) Name() string       { return i.name }
func (i *Info) Size() int64        { return i.st.Size }
func (i *Info) Mode() fs.FileMode  { return fileMode(i.st.Mode) }
func (i *Info) ModTime() time.Time { return time.Unix(i.st.Mtim.Unix()) }
func (i *Info) IsDir() bool        { return i.Mode().IsDir() }
func (i *Info) Sys() any           { return nil }

func fileMode(m uint32) fs.FileMode {
	mode := fs.FileMode(m & 0o777)
	switch m & unix.S_IFMT {
	case unix.S_IFDIR:
		mode |= fs.ModeDir
	case unix.S_IFLNK:
		mode |= fs.ModeSymlink
	case unix.S_IFIFO:
		mode |= fs.ModeNamedPipe
	case unix.S_IFSOCK:
		mode |= fs.ModeSocket
	case unix.S_IFCHR:
		mode |= fs.ModeDevice | fs.ModeCharDevice
	case unix.S_IFBLK:
		mode |= fs.ModeDevice
	}
	if m&unix.S_ISUID != 0 {
		mode |= fs.ModeSetuid
	}
	if m&unix.S_ISGID != 0 {
		mode |= fs.ModeSetgid
	}
	if m&unix.S_ISVTX != 0 {
		mode |= fs.ModeSticky
	}
	return mode
}

var textTypes = map[string]string{
	".txt": "text/plain", ".log": "text/plain", ".properties": "text/plain", ".cfg": "text/plain",
	".conf": "text/plain", ".ini": "text/plain", ".toml": "application/toml", ".yml": "application/yaml",
	".yaml": "application/yaml", ".json": "application/json", ".md": "text/markdown", ".sh": "text/x-shellscript",
	".php": "application/x-httpd-php", ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/plain",
	".css": "text/css", ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".env": "text/plain",
	".jar": "application/java-archive", ".zip": "application/zip", ".gz": "application/gzip",
	".tgz": "application/gzip", ".tar": "application/x-tar", ".zst": "application/zstd",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
	".webp": "image/webp", ".ico": "image/x-icon",
}

// MimeType raadt het type op basis van de extensie.
func MimeType(name string, dir bool) string {
	if dir {
		return "inode/directory"
	}
	ext := strings.ToLower(filepath.Ext(name))
	if t, ok := textTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		t, _, _ = strings.Cut(t, ";")
		return t
	}
	if ext == "" && !strings.Contains(name, ".") {
		return "application/octet-stream"
	}
	return "application/octet-stream"
}

// entryAt maakt een Entry voor name in de map dirfd (symlinks niet gevolgd, wel bekeken
// of het doel binnen de root een map is).
func entryAt(rootfd, dirfd int, dirRel, name string) (Entry, Info, error) {
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return Entry{}, Info{}, mapErr(err)
	}
	rel := name
	if dirRel != "." && dirRel != "" {
		rel = dirRel + "/" + name
	}
	info := Info{name: name, st: st}
	e := Entry{
		Name: name, Path: APIPath(rel), Size: st.Size,
		Mode:       fileMode(st.Mode).String(),
		ModifiedAt: time.Unix(st.Mtim.Unix()).UTC(),
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		e.IsDirectory = true
	case unix.S_IFLNK:
		e.IsSymlink = true
		if fd, err := openBeneath(rootfd, rel, unix.O_PATH, 0); err == nil {
			var tst unix.Stat_t
			if unix.Fstat(fd, &tst) == nil && tst.Mode&unix.S_IFMT == unix.S_IFDIR {
				e.IsDirectory = true
			}
			unix.Close(fd)
		}
	}
	e.MimeType = MimeType(name, e.IsDirectory)
	return e, info, nil
}

// List geeft de inhoud van een map: mappen eerst, dan op naam.
func (r *Root) List(p string) ([]Entry, error) {
	entries, _, err := r.list(p)
	return entries, err
}

// ListInfo is List voor SFTP.
func (r *Root) ListInfo(p string) ([]fs.FileInfo, error) {
	_, infos, err := r.list(p)
	return infos, err
}

func (r *Root) list(p string) ([]Entry, []fs.FileInfo, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, nil, err
	}
	root, err := r.rootFD()
	if err != nil {
		return nil, nil, err
	}
	defer unix.Close(root)
	fd, err := openBeneath(root, rel, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, nil, err
	}
	f := os.NewFile(uintptr(fd), rel)
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, nil, err
	}
	entries := make([]Entry, 0, len(names))
	infos := make([]fs.FileInfo, 0, len(names))
	for _, n := range names {
		e, info, err := entryAt(root, fd, rel, n)
		if err != nil {
			continue // tussendoor verwijderd
		}
		entries = append(entries, e)
		i := info
		infos = append(infos, &i)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, infos, nil
}

// Stat geeft de Entry van één pad (symlink zelf, niet gevolgd).
func (r *Root) Stat(p string) (Entry, error) {
	e, _, err := r.stat(p)
	return e, err
}

func (r *Root) stat(p string) (Entry, Info, error) {
	rel, err := Clean(p)
	if err != nil {
		return Entry{}, Info{}, err
	}
	root, err := r.rootFD()
	if err != nil {
		return Entry{}, Info{}, err
	}
	defer unix.Close(root)
	if rel == "." {
		var st unix.Stat_t
		if err := unix.Fstat(root, &st); err != nil {
			return Entry{}, Info{}, err
		}
		return Entry{Name: "/", Path: "/", IsDirectory: true, Mode: fileMode(st.Mode).String(), MimeType: "inode/directory",
			ModifiedAt: time.Unix(st.Mtim.Unix()).UTC()}, Info{name: "/", st: st}, nil
	}
	dir, name := path.Split(rel)
	dir = strings.TrimSuffix(dir, "/")
	if dir == "" {
		dir = "."
	}
	pfd, err := openBeneath(root, dir, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return Entry{}, Info{}, err
	}
	defer unix.Close(pfd)
	return entryAt(root, pfd, dir, name)
}

// Lstat geeft een fs.FileInfo zonder de symlink te volgen.
func (r *Root) Lstat(p string) (fs.FileInfo, error) {
	_, info, err := r.stat(p)
	if err != nil {
		return nil, err
	}
	return &info, nil
}

// StatFollow volgt een symlink (binnen de root).
func (r *Root) StatFollow(p string) (fs.FileInfo, error) {
	rel, err := Clean(p)
	if err != nil {
		return nil, err
	}
	fd, err := r.openat(rel, unix.O_PATH, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, err
	}
	return &Info{name: path.Base(APIPath(rel)), st: st}, nil
}

// Mkdir maakt een map (met ontbrekende tussenmappen). Bestaat hij al: ErrExists.
func (r *Root) Mkdir(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	if rel == "." {
		return ErrExists
	}
	if _, err := r.Lstat(p); err == nil {
		return ErrExists
	}
	return r.MkdirAll(rel)
}

// MkdirAll maakt rel en alle ontbrekende tussenmappen.
func (r *Root) MkdirAll(rel string) error {
	rel, err := Clean(rel)
	if err != nil || rel == "." {
		return err
	}
	parts := strings.Split(rel, "/")
	for i := range parts {
		sub := strings.Join(parts[:i+1], "/")
		pfd, name, err := r.parent(sub)
		if err != nil {
			return err
		}
		err = unix.Mkdirat(pfd, name, 0o755)
		if err == nil {
			_ = unix.Fchownat(pfd, name, r.UID, r.GID, unix.AT_SYMLINK_NOFOLLOW)
		}
		unix.Close(pfd)
		if err != nil && err != unix.EEXIST {
			return mapErr(err)
		}
	}
	// Controleer dat het eindresultaat een map binnen de root is.
	fd, err := r.openat(rel, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return err
	}
	unix.Close(fd)
	return nil
}

// Rename verplaatst from naar to; bestaat to al, dan ErrExists.
func (r *Root) Rename(from, to string) error {
	return r.rename(from, to, unix.RENAME_NOREPLACE)
}

// RenameReplace verplaatst en overschrijft (SFTP posix-rename).
func (r *Root) RenameReplace(from, to string) error { return r.rename(from, to, 0) }

func (r *Root) rename(from, to string, flags uint) error {
	fr, err := Clean(from)
	if err != nil {
		return err
	}
	tr, err := Clean(to)
	if err != nil {
		return err
	}
	if fr == "." || tr == "." {
		return ErrBadPath
	}
	if tr == fr || strings.HasPrefix(tr, fr+"/") {
		return ErrBadPath
	}
	ffd, fname, err := r.parent(fr)
	if err != nil {
		return err
	}
	defer unix.Close(ffd)
	tfd, tname, err := r.parent(tr)
	if err != nil {
		return err
	}
	defer unix.Close(tfd)
	return mapErr(unix.Renameat2(ffd, fname, tfd, tname, flags))
}

// Remove verwijdert een bestand, symlink of (lege) map.
func (r *Root) Remove(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	pfd, name, err := r.parent(rel)
	if err != nil {
		return err
	}
	defer unix.Close(pfd)
	err = unix.Unlinkat(pfd, name, 0)
	if err == unix.EISDIR {
		err = unix.Unlinkat(pfd, name, unix.AT_REMOVEDIR)
	}
	return mapErr(err)
}

// RemoveDir verwijdert een lege map.
func (r *Root) RemoveDir(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	pfd, name, err := r.parent(rel)
	if err != nil {
		return err
	}
	defer unix.Close(pfd)
	return mapErr(unix.Unlinkat(pfd, name, unix.AT_REMOVEDIR))
}

// RemoveAll verwijdert p met alles eronder. Symlinks worden zelf verwijderd, nooit gevolgd.
// Bestaat p niet, dan is dat geen fout.
func (r *Root) RemoveAll(p string) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	pfd, name, err := r.parent(rel)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	defer unix.Close(pfd)
	err = removeAllAt(pfd, name, 0)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func removeAllAt(dirfd int, name string, depth int) error {
	if depth > 512 {
		return errors.New("te diep genest")
	}
	err := unix.Unlinkat(dirfd, name, 0)
	if err == nil || err == unix.ENOENT {
		return nil
	}
	if err != unix.EISDIR && err != unix.EPERM {
		return mapErr(err)
	}
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return mapErr(err)
	}
	f := os.NewFile(uintptr(fd), name)
	for {
		names, rerr := f.Readdirnames(256)
		for _, n := range names {
			if err := removeAllAt(fd, n, depth+1); err != nil {
				f.Close()
				return err
			}
		}
		if rerr != nil || len(names) == 0 {
			break
		}
	}
	f.Close()
	err = unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR)
	if err == unix.ENOENT {
		return nil
	}
	return mapErr(err)
}

// Chmod zet de rechten (volgt een symlink binnen de root).
func (r *Root) Chmod(p string, mode os.FileMode) error {
	f, err := r.Open(p, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Chmod(mode.Perm())
}

// Truncate kort een bestand in.
func (r *Root) Truncate(p string, size int64) error {
	f, err := r.Open(p, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Truncate(size)
}

// Chtimes zet de tijden (volgt een symlink binnen de root).
func (r *Root) Chtimes(p string, atime, mtime time.Time) error {
	rel, err := Clean(p)
	if err != nil {
		return err
	}
	fd, err := r.openat(rel, unix.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	tv := []unix.Timeval{unix.NsecToTimeval(atime.UnixNano()), unix.NsecToTimeval(mtime.UnixNano())}
	return unix.Futimes(fd, tv)
}

// Symlink maakt link → target. Het doel mag overal heen wijzen: de daemon volgt
// symlinks alleen binnen de root, en in de container is het de eigen data.
func (r *Root) Symlink(target, link string) error {
	rel, err := Clean(link)
	if err != nil {
		return err
	}
	if strings.ContainsRune(target, 0) {
		return ErrBadPath
	}
	pfd, name, err := r.parent(rel)
	if err != nil {
		return err
	}
	defer unix.Close(pfd)
	if err := unix.Symlinkat(target, pfd, name); err != nil {
		return mapErr(err)
	}
	_ = unix.Fchownat(pfd, name, r.UID, r.GID, unix.AT_SYMLINK_NOFOLLOW)
	return nil
}

// Readlink geeft het doel van een symlink.
func (r *Root) Readlink(p string) (string, error) {
	rel, err := Clean(p)
	if err != nil {
		return "", err
	}
	pfd, name, err := r.parent(rel)
	if err != nil {
		return "", err
	}
	defer unix.Close(pfd)
	buf := make([]byte, 4096)
	n, err := unix.Readlinkat(pfd, name, buf)
	if err != nil {
		return "", mapErr(err)
	}
	return string(buf[:n]), nil
}
