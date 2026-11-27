package api

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"panel/daemon/internal/auth"
	"panel/daemon/internal/files"
	"panel/daemon/internal/server"
)

const (
	maxReadBytes  = 5 << 20
	maxWriteBytes = 50 << 20
)

func fileErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, files.ErrBadPath), errors.Is(err, files.ErrEscape):
		writeErr(w, http.StatusBadRequest, "bad_path", err.Error())
	case errors.Is(err, files.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, files.ErrExists):
		writeErr(w, http.StatusConflict, "conflict", err.Error())
	case errors.Is(err, files.ErrNotDir), errors.Is(err, files.ErrIsDir), errors.Is(err, files.ErrNotFile), errors.Is(err, files.ErrBadFormat):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, files.ErrTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", err.Error())
	case errors.Is(err, files.ErrDiskFull), errors.Is(err, server.ErrDiskExceeded):
		writeErr(w, http.StatusInsufficientStorage, "disk_exceeded", "server disk limit reached")
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (a *API) listFiles(w http.ResponseWriter, r *http.Request, s *server.Server) {
	l, err := s.Root().List(r.URL.Query().Get("path"))
	if err != nil {
		fileErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (a *API) readFile(w http.ResponseWriter, r *http.Request, s *server.Server) {
	f, fi, err := s.Root().OpenRead(r.URL.Query().Get("path"))
	if err != nil {
		fileErr(w, err)
		return
	}
	defer f.Close()
	if fi.Size() > maxReadBytes {
		fileErr(w, files.ErrTooLarge)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	_, _ = io.CopyN(w, f, fi.Size())
}

func (a *API) writeFile(w http.ResponseWriter, r *http.Request, s *server.Server) {
	root := s.Root()
	p := r.URL.Query().Get("path")
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWriteBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if len(body) > maxWriteBytes {
		fileErr(w, files.ErrTooLarge)
		return
	}
	var old int64
	if e, err := root.Stat(p); err == nil && !e.IsSymlink {
		old = e.Size
	}
	if err := s.CheckWrite(int64(len(body)) - old); err != nil {
		fileErr(w, err)
		return
	}
	rel, err := files.Clean(p)
	if err != nil {
		fileErr(w, err)
		return
	}
	if err := root.MkdirAll(path.Dir(rel)); err != nil {
		fileErr(w, err)
		return
	}
	f, err := root.Open(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		fileErr(w, err)
		return
	}
	_, err = f.Write(body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		fileErr(w, err)
		return
	}
	s.AddDisk(int64(len(body)) - old)
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) mkdir(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Path string `json:"path"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	if err := s.Root().Mkdir(body.Path); err != nil {
		fileErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) rename(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.Root().Rename(body.From, body.To); err != nil {
		fileErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) deleteFiles(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Paths) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "paths is leeg")
		return
	}
	root := s.Root()
	for _, p := range body.Paths {
		rel, err := files.Clean(p)
		if err == nil && rel == "." {
			err = files.ErrBadPath
		}
		if err != nil {
			fileErr(w, err)
			return
		}
	}
	for _, p := range body.Paths {
		if err := root.RemoveAll(p); err != nil {
			fileErr(w, err)
			return
		}
	}
	s.RemeasureDisk()
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) compress(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Root  string   `json:"root"`
		Paths []string `json:"paths"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Paths) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "paths is leeg")
		return
	}
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	e, err := s.Root().Compress(body.Root, body.Paths, s.Budget())
	if err != nil {
		fileErr(w, err)
		return
	}
	s.AddDisk(e.Size)
	writeJSON(w, http.StatusOK, e)
}

func (a *API) decompress(w http.ResponseWriter, r *http.Request, s *server.Server) {
	var body struct {
		Path string `json:"path"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	err := s.Root().Decompress(body.Path, s.Budget())
	s.RemeasureDisk()
	if err != nil {
		fileErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- upload/download met eenmalige JWT ----------

// jtiStore onthoudt gebruikte jti's tot hun exp.
type jtiStore struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// use geeft false als de jti al gebruikt is.
func (j *jtiStore) use(id string, exp time.Time) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	now := time.Now()
	if j.seen == nil {
		j.seen = map[string]time.Time{}
	}
	for k, e := range j.seen {
		if now.After(e.Add(time.Minute)) {
			delete(j.seen, k)
		}
	}
	if _, ok := j.seen[id]; ok {
		return false
	}
	j.seen[id] = exp
	return true
}

func (a *API) cors(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			for _, allowed := range a.opt.AllowedOrigins {
				if o == allowed {
					w.Header().Set("Access-Control-Allow-Origin", o)
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
					w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, Content-Length")
					w.Header().Set("Access-Control-Max-Age", "600")
					break
				}
			}
			w.Header().Add("Vary", "Origin")
		}
		h(w, r)
	}
}

func preflight(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }

// transferAuth controleert de eenmalige JWT in ?token=.
func (a *API) transferAuth(w http.ResponseWriter, r *http.Request, perm string) (*server.Server, *auth.Claims, bool) {
	tok := r.URL.Query().Get("token")
	if tok == "" {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "token missing")
		return nil, nil, false
	}
	claims, err := a.jwt.Verify(r.Context(), tok)
	if err != nil || claims.ID == "" || !strings.EqualFold(claims.ServerUUID, r.PathValue("uuid")) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "token invalid")
		return nil, nil, false
	}
	if !claims.Has(perm) {
		writeErr(w, http.StatusForbidden, "forbidden", perm+" missing")
		return nil, nil, false
	}
	if !a.jti.use(claims.ID, claims.ExpiresAt.Time) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "token already used")
		return nil, nil, false
	}
	s, ok := a.mgr.Get(r.PathValue("uuid"))
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "server unknown on this node")
		return nil, nil, false
	}
	return s, claims, true
}

func (a *API) download(w http.ResponseWriter, r *http.Request) {
	s, _, ok := a.transferAuth(w, r, "files.read")
	if !ok {
		return
	}
	f, fi, err := s.Root().OpenRead(r.URL.Query().Get("path"))
	if err != nil {
		fileErr(w, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": fi.Name()}))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

func (a *API) upload(w http.ResponseWriter, r *http.Request) {
	s, _, ok := a.transferAuth(w, r, "files.write")
	if !ok {
		return
	}
	dir, err := files.Clean(r.URL.Query().Get("directory"))
	if err != nil {
		fileErr(w, err)
		return
	}
	if err := s.CheckWrite(0); err != nil {
		fileErr(w, err)
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "multipart/form-data verwacht")
		return
	}
	root := s.Root()
	if err := root.MkdirAll(dir); err != nil {
		fileErr(w, err)
		return
	}
	n := 0
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		name := part.FileName()
		if name == "" {
			part.Close()
			continue
		}
		name = path.Base(strings.ReplaceAll(name, "\\", "/"))
		if name == "." || name == ".." || name == "/" {
			part.Close()
			writeErr(w, http.StatusBadRequest, "bad_path", "invalid file name")
			return
		}
		target := files.APIPath(dir) + "/" + name
		if dir == "." {
			target = "/" + name
		}
		if err := a.saveUpload(s, root, target, part); err != nil {
			part.Close()
			fileErr(w, err)
			return
		}
		part.Close()
		n++
	}
	if n == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "no files in files")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) saveUpload(s *server.Server, root *files.Root, target string, src io.Reader) error {
	tmp := target + ".upload-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	f, err := root.Open(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	lw := &files.LimitWriter{W: f, Budget: s.Budget()}
	_, err = io.Copy(lw, src)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = root.RenameReplace(tmp, target)
	}
	if err != nil {
		_ = root.Remove(tmp)
		return err
	}
	s.AddDisk(lw.Written)
	return nil
}
