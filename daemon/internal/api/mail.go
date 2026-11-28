package api

import (
	"context"
	"errors"
	"net/http"

	"panel/daemon/internal/mail"
)

// Mail is de mailbeheerder van de lokale node (internal/mail).
type Mail interface {
	RunChecks(ctx context.Context, req mail.CheckRequest) (mail.Report, error)
	Status(ctx context.Context) (mail.Status, error)
	Enable(ctx context.Context) error
	Disable(ctx context.Context) error
	Reload(ctx context.Context) error
	PutDKIM(ctx context.Context, domain, selector, keyPEM string) error
	DeleteDKIM(ctx context.Context, domain string) error
	Queue(ctx context.Context) ([]mail.QueueItem, error)
	FlushQueue(ctx context.Context) error
	DeleteQueued(ctx context.Context, id string) error
	Quota(ctx context.Context, addrs []string) ([]mail.QuotaItem, error)
	DeleteMailboxData(ctx context.Context, address string) error
}

// SetMail koppelt de mailbeheerder (zonder: 404 not_local, bv. op een remote node).
func (a *API) SetMail(m Mail) { a.mail = m }

func (a *API) mailRoutes(mux *http.ServeMux) {
	p := func(h http.HandlerFunc) http.Handler { return a.protect(a.mailReady(h)) }
	mux.Handle("POST /api/mail/checks", p(a.mailChecks))
	mux.Handle("GET /api/mail/status", p(a.mailStatus))
	mux.Handle("POST /api/mail/enable", p(a.mailEnable))
	mux.Handle("POST /api/mail/disable", p(a.mailDisable))
	mux.Handle("POST /api/mail/reload", p(a.mailReload))
	mux.Handle("PUT /api/mail/dkim/{domain}", p(a.mailPutDKIM))
	mux.Handle("DELETE /api/mail/dkim/{domain}", p(a.mailDeleteDKIM))
	mux.Handle("GET /api/mail/queue", p(a.mailQueue))
	mux.Handle("POST /api/mail/queue/flush", p(a.mailFlush))
	mux.Handle("DELETE /api/mail/queue/{queue_id}", p(a.mailDeleteQueued))
	mux.Handle("POST /api/mail/mailboxes/quota", p(a.mailQuota))
	mux.Handle("DELETE /api/mail/mailboxes/{address}/data", p(a.mailDeleteData))
}

func (a *API) mailReady(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.mail == nil {
			writeErr(w, http.StatusNotFound, "not_local", "mail is only available on the local node")
			return
		}
		h(w, r)
	}
}

func mailErr(w http.ResponseWriter, err error) {
	var ee *mail.ExecError
	switch {
	case errors.Is(err, mail.ErrInvalid):
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, mail.ErrNotConfigured):
		writeErr(w, http.StatusConflict, "mail_not_configured", err.Error())
	case errors.Is(err, mail.ErrNotRunning):
		writeErr(w, http.StatusConflict, "mail_not_running", err.Error())
	case errors.Is(err, mail.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, mail.ErrNoCompose):
		writeErr(w, http.StatusNotFound, "not_local", err.Error())
	case errors.As(err, &ee):
		writeErr(w, http.StatusBadGateway, "mail_command_failed", ee.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	}
}

func (a *API) mailChecks(w http.ResponseWriter, r *http.Request) {
	var req mail.CheckRequest
	if !decode(w, r, &req) {
		return
	}
	rep, err := a.mail.RunChecks(r.Context(), req)
	if err != nil {
		mailErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (a *API) mailStatus(w http.ResponseWriter, r *http.Request) {
	st, err := a.mail.Status(r.Context())
	if err != nil {
		mailErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (a *API) mailNoContent(fn func(context.Context) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(r.Context()); err != nil {
			mailErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *API) mailEnable(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(a.mail.Enable)(w, r)
}
func (a *API) mailDisable(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(a.mail.Disable)(w, r)
}
func (a *API) mailReload(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(a.mail.Reload)(w, r)
}
func (a *API) mailFlush(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(a.mail.FlushQueue)(w, r)
}

func (a *API) mailPutDKIM(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Selector      string `json:"selector"`
		PrivateKeyPEM string `json:"private_key_pem"`
	}
	if !decode(w, r, &body) {
		return
	}
	a.mailNoContent(func(ctx context.Context) error {
		return a.mail.PutDKIM(ctx, r.PathValue("domain"), body.Selector, body.PrivateKeyPEM)
	})(w, r)
}

func (a *API) mailDeleteDKIM(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(func(ctx context.Context) error { return a.mail.DeleteDKIM(ctx, r.PathValue("domain")) })(w, r)
}

func (a *API) mailQueue(w http.ResponseWriter, r *http.Request) {
	items, err := a.mail.Queue(r.Context())
	if err != nil {
		mailErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) mailDeleteQueued(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(func(ctx context.Context) error { return a.mail.DeleteQueued(ctx, r.PathValue("queue_id")) })(w, r)
}

func (a *API) mailQuota(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Addresses []string `json:"addresses"`
	}
	if !decode(w, r, &body) {
		return
	}
	items, err := a.mail.Quota(r.Context(), body.Addresses)
	if err != nil {
		mailErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *API) mailDeleteData(w http.ResponseWriter, r *http.Request) {
	a.mailNoContent(func(ctx context.Context) error { return a.mail.DeleteMailboxData(ctx, r.PathValue("address")) })(w, r)
}
