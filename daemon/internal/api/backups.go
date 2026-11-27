package api

import (
	"errors"
	"net/http"
	"strconv"

	"panel/daemon/internal/backup"
	"panel/daemon/internal/server"
)

// Backups is wat de API van het backup-pakket nodig heeft.
type Backups interface {
	StartBackup(sv *server.Server, req backup.BackupRequest) error
	StartRestore(sv *server.Server, backupID int, req backup.RestoreRequest) error
	Progress(uuid string) (backup.Progress, bool)
	Cancel(uuid string, backupID int) error
}

// SetBackups koppelt de backup-service (zonder: 501).
func (a *API) SetBackups(b Backups) { a.backups = b }

func (a *API) createBackup(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if a.backups == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "backups are not enabled")
		return
	}
	var req backup.BackupRequest
	if !decode(w, r, &req) {
		return
	}
	if req.BackupID < 1 || req.Key == "" || req.S3.Bucket == "" || req.S3.Endpoint == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "backup_id, key and s3 are required")
		return
	}
	if err := backup.ValidateDatabases(req.Databases); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := a.backups.StartBackup(s, req); err != nil {
		backupErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) restoreBackup(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if a.backups == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "backups are not enabled")
		return
	}
	id, err := strconv.Atoi(r.PathValue("backup_id"))
	if err != nil || id < 1 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid backup_id")
		return
	}
	var req backup.RestoreRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Key == "" || req.S3.Bucket == "" || req.S3.Endpoint == "" || len(req.SHA256) != 64 {
		writeErr(w, http.StatusBadRequest, "bad_request", "key, sha256 and s3 are required")
		return
	}
	if err := backup.ValidateDatabases(req.Databases); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if st := s.State(); st == server.StateInstalling {
		writeErr(w, http.StatusConflict, "invalid_state", "installation is running")
		return
	}
	if err := a.backups.StartRestore(s, id, req); err != nil {
		backupErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// backupProgress geeft de lopende backup of het lopende herstel (progress: null als er niets loopt).
func (a *API) backupProgress(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if a.backups == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "backups are not enabled")
		return
	}
	if p, ok := a.backups.Progress(s.UUID()); ok {
		writeJSON(w, http.StatusOK, map[string]any{"progress": p})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"progress": nil})
}

func (a *API) cancelBackup(w http.ResponseWriter, r *http.Request, s *server.Server) {
	if a.backups == nil {
		writeErr(w, http.StatusNotImplemented, "not_implemented", "backups are not enabled")
		return
	}
	id, err := strconv.Atoi(r.PathValue("backup_id"))
	if err != nil || id < 1 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid backup_id")
		return
	}
	if err := a.backups.Cancel(s.UUID(), id); err != nil {
		backupErr(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func backupErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, backup.ErrBusy):
		writeErr(w, http.StatusConflict, "conflict", err.Error())
		return
	case errors.Is(err, backup.ErrNotRunning):
		writeErr(w, http.StatusNotFound, "not_running", err.Error())
		return
	case errors.Is(err, backup.ErrNotCancellable):
		writeErr(w, http.StatusConflict, "not_cancellable", err.Error())
		return
	}
	writeErr(w, http.StatusInternalServerError, "internal", err.Error())
}
