// Package sftpd is de SFTP-server van de daemon. Inloggen gaat via het panel
// (POST /api/remote/sftp/auth); files.read en files.write uit het antwoord dwingt de
// daemon zelf af. Alle paden lopen via files.Root (geen ontsnapping uit de serverdata).
package sftpd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"panel/daemon/internal/files"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/server"
)

// Authenticator controleert logins (panel.Client).
type Authenticator interface {
	SFTPAuth(ctx context.Context, username, password, ip string) (*panel.SFTPAuth, error)
}

// Server is de SFTP-server.
type Server struct {
	Auth    Authenticator
	Servers *server.Manager
	Log     *slog.Logger
	// FailDelay na een mislukte login (tegen raden; het panel limiteert ook).
	FailDelay time.Duration

	cfg *ssh.ServerConfig
	ln  net.Listener

	mu    sync.Mutex
	conns map[net.Conn]struct{}
	wg    sync.WaitGroup
}

// LoadHostKey leest de host-sleutel of maakt er een (ed25519, PEM, 0600).
func LoadHostKey(path string) (ssh.Signer, error) {
	if b, err := os.ReadFile(path); err == nil {
		return ssh.ParsePrivateKey(b)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	blk, err := ssh.MarshalPrivateKey(priv, "panel-daemon")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, pem.EncodeToMemory(blk), 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(priv)
}

// Start begint te luisteren op addr.
func (s *Server) Start(addr string, key ssh.Signer) error {
	if s.FailDelay == 0 {
		s.FailDelay = time.Second
	}
	s.conns = map[net.Conn]struct{}{}
	s.cfg = &ssh.ServerConfig{
		PasswordCallback: s.password,
		MaxAuthTries:     3,
		ServerVersion:    "SSH-2.0-panel-sftp",
	}
	s.cfg.AddHostKey(key)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln
	s.wg.Add(1)
	go s.accept()
	return nil
}

// Addr is het luisteradres.
func (s *Server) Addr() string { return s.ln.Addr().String() }

// Close stopt de server en verbreekt alle verbindingen.
func (s *Server) Close() {
	if s.ln == nil {
		return
	}
	s.ln.Close()
	s.mu.Lock()
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Server) accept() {
	defer s.wg.Done()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		s.mu.Lock()
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() {
				s.mu.Lock()
				delete(s.conns, c)
				s.mu.Unlock()
				c.Close()
			}()
			s.handle(c)
		}()
	}
}

const (
	extUUID  = "server_uuid"
	extPerms = "permissions"
	extUser  = "user_id"
)

func (s *Server) password(meta ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
	user := meta.User()
	fail := func(why string) (*ssh.Permissions, error) {
		s.Log.Info("sftp login refused", "user", user, "ip", meta.RemoteAddr().String(), "why", why)
		time.Sleep(s.FailDelay)
		return nil, errors.New("access denied")
	}
	i := strings.LastIndex(user, ".")
	if i <= 0 || i == len(user)-1 || len(pw) == 0 || len(pw) > 1024 {
		return fail("invalid username")
	}
	shortID := strings.ToLower(user[i+1:])
	ip, _, _ := net.SplitHostPort(meta.RemoteAddr().String())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := s.Auth.SFTPAuth(ctx, user, string(pw), ip)
	if err != nil {
		return fail(err.Error())
	}
	uuid := strings.ToLower(res.ServerUUID)
	if !strings.HasPrefix(uuid, shortID) {
		return fail("server_uuid does not match the username")
	}
	if _, ok := s.Servers.Get(uuid); !ok {
		return fail("server niet op deze node")
	}
	if !slices.Contains(res.Permissions, "files.read") {
		return fail("files.read missing")
	}
	return &ssh.Permissions{Extensions: map[string]string{
		extUUID: uuid, extPerms: strings.Join(res.Permissions, ","), extUser: res.UserID,
	}}, nil
}

func (s *Server) handle(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	sc, chans, reqs, err := ssh.NewServerConn(c, s.cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	_ = c.SetDeadline(time.Time{})
	go ssh.DiscardRequests(reqs)
	uuid := sc.Permissions.Extensions[extUUID]
	perms := strings.Split(sc.Permissions.Extensions[extPerms], ",")
	s.Log.Info("sftp-sessie", "user", sc.User(), "server", uuid, "ip", c.RemoteAddr().String())
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "alleen sessies")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			continue
		}
		go s.session(ch, creqs, uuid, perms)
	}
}

func (s *Server) session(ch ssh.Channel, reqs <-chan *ssh.Request, uuid string, perms []string) {
	defer ch.Close()
	for req := range reqs {
		ok := req.Type == "subsystem" && len(req.Payload) >= 4 && string(req.Payload[4:]) == "sftp"
		_ = req.Reply(ok, nil)
		if !ok {
			continue
		}
		go ssh.DiscardRequests(reqs)
		h := &handler{m: s.Servers, uuid: uuid, write: slices.Contains(perms, "files.write")}
		rs := sftp.NewRequestServer(ch, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h})
		if err := rs.Serve(); err != nil && !errors.Is(err, io.EOF) {
			s.Log.Debug("sftp-sessie eindigt", "err", err)
		}
		rs.Close()
		return
	}
}

// ---------- handlers ----------

type handler struct {
	m     *server.Manager
	uuid  string
	write bool
}

func (h *handler) srv() (*server.Server, error) {
	s, ok := h.m.Get(h.uuid)
	if !ok {
		return nil, sftp.ErrSSHFxNoSuchFile
	}
	return s, nil
}

func sftpErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, files.ErrNotFound):
		return os.ErrNotExist
	case errors.Is(err, files.ErrExists):
		return os.ErrExist
	case errors.Is(err, files.ErrEscape), errors.Is(err, files.ErrBadPath):
		return sftp.ErrSSHFxPermissionDenied
	case errors.Is(err, files.ErrDiskFull), errors.Is(err, server.ErrDiskExceeded):
		return sftp.ErrSSHFxFailure
	}
	return err
}

func (h *handler) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	s, err := h.srv()
	if err != nil {
		return nil, err
	}
	f, _, err := s.Root().OpenRead(r.Filepath)
	return f, sftpErr(err)
}

// limitedFile bewaakt de disk-limiet tijdens het schrijven.
type limitedFile struct {
	f      *os.File
	s      *server.Server
	budget files.Budget
	start  int64
	max    int64
}

func (l *limitedFile) WriteAt(p []byte, off int64) (int, error) {
	end := off + int64(len(p))
	if l.budget >= 0 && end-l.start > int64(l.budget) {
		return 0, sftp.ErrSSHFxFailure
	}
	n, err := l.f.WriteAt(p, off)
	if off+int64(n) > l.max {
		l.max = off + int64(n)
	}
	return n, err
}

func (l *limitedFile) Close() error {
	if l.max > l.start {
		l.s.AddDisk(l.max - l.start)
	}
	return l.f.Close()
}

func (h *handler) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	if !h.write {
		return nil, sftp.ErrSSHFxPermissionDenied
	}
	s, err := h.srv()
	if err != nil {
		return nil, err
	}
	if err := s.CheckWrite(0); err != nil {
		return nil, sftpErr(err)
	}
	pf := r.Pflags()
	flags := os.O_WRONLY
	if pf.Read {
		flags = os.O_RDWR
	}
	if pf.Creat {
		flags |= os.O_CREATE
	}
	if pf.Trunc {
		flags |= os.O_TRUNC
	}
	if pf.Excl {
		flags |= os.O_EXCL
	}
	if pf.Append {
		flags |= os.O_APPEND
	}
	f, err := s.Root().Open(r.Filepath, flags, 0o644)
	if err != nil {
		return nil, sftpErr(err)
	}
	var size int64
	if fi, err := f.Stat(); err == nil {
		size = fi.Size()
	}
	return &limitedFile{f: f, s: s, budget: s.Budget(), start: size, max: size}, nil
}

func (h *handler) Filecmd(r *sftp.Request) error {
	if !h.write {
		return sftp.ErrSSHFxPermissionDenied
	}
	s, err := h.srv()
	if err != nil {
		return err
	}
	root := s.Root()
	switch r.Method {
	case "Setstat":
		af := r.AttrFlags()
		a := r.Attributes()
		if af.Size {
			if err := s.CheckWrite(0); err != nil {
				return sftpErr(err)
			}
			if err := root.Truncate(r.Filepath, int64(a.Size)); err != nil {
				return sftpErr(err)
			}
		}
		if af.Permissions {
			if err := root.Chmod(r.Filepath, os.FileMode(a.Mode).Perm()); err != nil {
				return sftpErr(err)
			}
		}
		if af.Acmodtime {
			if err := root.Chtimes(r.Filepath, time.Unix(int64(a.Atime), 0), time.Unix(int64(a.Mtime), 0)); err != nil {
				return sftpErr(err)
			}
		}
		return nil // uid/gid negeren
	case "Rename":
		return sftpErr(root.Rename(r.Filepath, r.Target))
	case "Rmdir":
		return sftpErr(root.RemoveDir(r.Filepath))
	case "Remove":
		err := root.Remove(r.Filepath)
		s.RemeasureDisk()
		return sftpErr(err)
	case "Mkdir":
		if err := s.CheckWrite(0); err != nil {
			return sftpErr(err)
		}
		return sftpErr(root.Mkdir(r.Filepath))
	case "Symlink":
		if err := s.CheckWrite(0); err != nil {
			return sftpErr(err)
		}
		// r.Filepath = doel, r.Target = nieuwe link (pkg/sftp-volgorde)
		return sftpErr(root.Symlink(r.Filepath, r.Target))
	case "Link":
		return sftp.ErrSSHFxOpUnsupported
	}
	return sftp.ErrSSHFxOpUnsupported
}

// PosixRename overschrijft het doel.
func (h *handler) PosixRename(r *sftp.Request) error {
	if !h.write {
		return sftp.ErrSSHFxPermissionDenied
	}
	s, err := h.srv()
	if err != nil {
		return err
	}
	return sftpErr(s.Root().RenameReplace(r.Filepath, r.Target))
}

type listerAt []os.FileInfo

func (l listerAt) ListAt(out []os.FileInfo, off int64) (int, error) {
	if off >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(out, l[off:])
	if n < len(out) || off+int64(n) >= int64(len(l)) {
		return n, io.EOF
	}
	return n, nil
}

type named struct {
	os.FileInfo
	name string
}

func (n named) Name() string { return n.name }

func (h *handler) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	s, err := h.srv()
	if err != nil {
		return nil, err
	}
	root := s.Root()
	switch r.Method {
	case "List":
		l, err := root.ListInfo(r.Filepath)
		if err != nil {
			return nil, sftpErr(err)
		}
		return listerAt(l), nil
	case "Stat":
		fi, err := root.StatFollow(r.Filepath)
		if err != nil {
			return nil, sftpErr(err)
		}
		return listerAt{fi}, nil
	case "Readlink":
		t, err := root.Readlink(r.Filepath)
		if err != nil {
			return nil, sftpErr(err)
		}
		fi, err := root.Lstat(r.Filepath)
		if err != nil {
			return nil, sftpErr(err)
		}
		return listerAt{named{fi, t}}, nil
	}
	return nil, fmt.Errorf("%w: %s", sftp.ErrSSHFxOpUnsupported, r.Method)
}

// Lstat volgt geen symlinks.
func (h *handler) Lstat(r *sftp.Request) (sftp.ListerAt, error) {
	s, err := h.srv()
	if err != nil {
		return nil, err
	}
	fi, err := s.Root().Lstat(r.Filepath)
	if err != nil {
		return nil, sftpErr(err)
	}
	return listerAt{fi}, nil
}
