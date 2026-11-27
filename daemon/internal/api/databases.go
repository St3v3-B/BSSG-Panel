package api

import (
	"context"
	"errors"
	"io"
	"net/http"

	"panel/daemon/internal/dbadmin"
)

// DBAdmin is wat de API van het dbadmin-pakket nodig heeft.
type DBAdmin interface {
	Status(ctx context.Context) error
	Create(ctx context.Context, db, user, password string) error
	SetPassword(ctx context.Context, user, password string) error
	Drop(ctx context.Context, db, user string) error
	Dump(ctx context.Context, db string, w io.Writer) error
	Import(ctx context.Context, db string, in io.Reader) error
	Exists(ctx context.Context, db string) (bool, error)
	SyncPmaUser(ctx context.Context, user, password string, dbs []string) error
}

// SetDBAdmin koppelt de databasebeheerder en de naam waaronder sites de database bereiken (zonder: 503).
func (a *API) SetDBAdmin(d DBAdmin, host string) { a.dbadmin, a.dbHost = d, host }

func dbErr(w http.ResponseWriter, err error) {
	var ce *dbadmin.Error
	switch {
	case errors.Is(err, dbadmin.ErrInvalid):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, dbadmin.ErrExists):
		writeErr(w, http.StatusConflict, "exists", err.Error())
	case errors.Is(err, dbadmin.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, dbadmin.ErrUnavailable):
		writeErr(w, http.StatusServiceUnavailable, "db_unavailable", err.Error())
	case errors.As(err, &ce):
		writeErr(w, http.StatusInternalServerError, "db_error", ce.Msg)
	default:
		writeErr(w, http.StatusInternalServerError, "db_error", err.Error())
	}
}

func (a *API) dbReady(w http.ResponseWriter) bool {
	if a.dbadmin == nil {
		writeErr(w, http.StatusServiceUnavailable, "db_unavailable", "no MariaDB on this node")
		return false
	}
	return true
}

func (a *API) dbStatus(w http.ResponseWriter, r *http.Request) {
	if a.dbadmin == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "error": "no MariaDB configured on this node"})
		return
	}
	if err := a.dbadmin.Status(r.Context()); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "error": err.Error(), "host": a.dbHost})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "host": a.dbHost})
}

type dbCreateReq struct {
	Name     string `json:"name"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *API) dbCreate(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	var req dbCreateReq
	if !decode(w, r, &req) {
		return
	}
	if err := a.dbadmin.Create(r.Context(), req.Name, req.Username, req.Password); err != nil {
		dbErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) dbDrop(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	if err := a.dbadmin.Drop(r.Context(), r.PathValue("name"), r.URL.Query().Get("username")); err != nil {
		dbErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type pmaSyncReq struct {
	Password  string   `json:"password"`
	Databases []string `json:"databases"`
}

func (a *API) dbPmaUser(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	var req pmaSyncReq
	if !decode(w, r, &req) {
		return
	}
	if err := a.dbadmin.SyncPmaUser(r.Context(), r.PathValue("username"), req.Password, req.Databases); err != nil {
		dbErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) dbPassword(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	var req dbCreateReq
	if !decode(w, r, &req) {
		return
	}
	if err := a.dbadmin.SetPassword(r.Context(), req.Username, req.Password); err != nil {
		dbErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// lazyHeader stuurt de 200-status pas bij de eerste byte, zodat een mislukte dump nog een nette fout kan geven.
type lazyHeader struct {
	w       http.ResponseWriter
	started bool
}

func (l *lazyHeader) Write(p []byte) (int, error) {
	if !l.started {
		l.started = true
		l.w.Header().Set("Content-Type", "application/sql")
		l.w.WriteHeader(http.StatusOK)
	}
	return l.w.Write(p)
}

func (a *API) dbDump(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	name := r.PathValue("name")
	ok, err := a.dbadmin.Exists(r.Context(), name)
	if err != nil {
		dbErr(w, err)
		return
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "not_found", "database not found")
		return
	}
	lh := &lazyHeader{w: w}
	if err := a.dbadmin.Dump(r.Context(), name, lh); err != nil {
		if !lh.started {
			dbErr(w, err)
			return
		}
		a.log.Warn("db dump", "db", name, "err", err)
		panic(http.ErrAbortHandler)
	}
	if !lh.started { // lege uitvoer kan niet; toch een geldige respons
		lh.Write(nil) //nolint:errcheck
	}
}

// errReader onthoudt de eerste leesfout (een afgebroken upload), zodat een afgekapte dump niet als gelukt telt.
type errReader struct {
	r   io.Reader
	err error
}

func (e *errReader) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF && e.err == nil {
		e.err = err
	}
	return n, err
}

func (a *API) dbImport(w http.ResponseWriter, r *http.Request) {
	if !a.dbReady(w) {
		return
	}
	body := &errReader{r: r.Body}
	err := a.dbadmin.Import(r.Context(), r.PathValue("name"), body)
	if body.err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "upload interrupted: "+body.err.Error())
		return
	}
	if err != nil {
		var ce *dbadmin.Error
		if errors.As(err, &ce) {
			writeErr(w, http.StatusInternalServerError, "import_failed", ce.Msg)
			return
		}
		dbErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
