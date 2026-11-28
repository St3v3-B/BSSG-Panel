package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"panel/daemon/internal/auth"
	"panel/daemon/internal/server"
)

// Sluitcodes van de webterminal (naast die van /ws).
const (
	CloseTerminalIdle = 4009
	CloseTooMany      = 4029
)

// Standaardtijden van de webterminal (Options.TerminalIdle / TerminalMax).
const (
	DefaultTerminalIdle = 15 * time.Minute
	DefaultTerminalMax  = 4 * time.Hour
)

type termIn struct {
	Event string `json:"event"`
	Token string `json:"token"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
}

type termSession struct {
	a    *API
	conn *websocket.Conn
	uuid string

	wmu    sync.Mutex // schrijven naar de websocket
	mu     sync.Mutex
	sub    string
	warn   *time.Timer
	exp    *time.Timer
	idle   *time.Timer
	closed bool
	shell  *server.Shell
}

// verifyTerminal controleert een terminal-token: handtekening, purpose, recht, server en eenmalig gebruik.
func (a *API) verifyTerminal(ctx context.Context, token, uuid string) (*auth.Claims, int, string) {
	claims, err := a.jwt.Verify(ctx, token)
	if err != nil {
		return nil, CloseTokenInvalid, "token invalid"
	}
	if claims.Purpose != "terminal" {
		return nil, CloseNoConsole, "not a terminal token"
	}
	if !claims.Has("terminal") {
		return nil, CloseNoConsole, "permission terminal missing"
	}
	if !strings.EqualFold(claims.ServerUUID, uuid) {
		return nil, CloseTokenInvalid, "token belongs to another server"
	}
	if claims.ID == "" || claims.ExpiresAt == nil || !a.jti.use(claims.ID, claims.ExpiresAt.Time) {
		return nil, CloseTokenInvalid, "token already used"
	}
	return claims, 0, ""
}

func (t *termSession) send(v any) {
	b, _ := json.Marshal(v)
	t.wmu.Lock()
	defer t.wmu.Unlock()
	_ = t.conn.SetWriteDeadline(time.Now().Add(20 * time.Second))
	_ = t.conn.WriteMessage(websocket.TextMessage, b)
}

func (t *termSession) close(code int, text string) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	for _, tm := range []*time.Timer{t.warn, t.exp, t.idle} {
		if tm != nil {
			tm.Stop()
		}
	}
	sh := t.shell
	t.mu.Unlock()
	t.wmu.Lock()
	_ = t.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, text), time.Now().Add(2*time.Second))
	t.wmu.Unlock()
	t.conn.Close()
	if sh != nil {
		sh.Close()
	}
}

// arm zet de timers voor token-verloop (na elke geldige auth).
func (t *termSession) arm(c *auth.Claims) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.warn != nil {
		t.warn.Stop()
	}
	if t.exp != nil {
		t.exp.Stop()
	}
	exp := c.ExpiresAt.Time
	t.warn = time.AfterFunc(max(time.Until(exp)-time.Minute, 0), func() {
		t.send(server.Msg{"event": "token_expiring", "expires_at": exp.UTC().Format(time.RFC3339)})
	})
	t.exp = time.AfterFunc(max(time.Until(exp), 0), func() {
		t.send(server.Msg{"event": "token_expired"})
		t.close(CloseTokenInvalid, "token expired")
	})
}

func (t *termSession) touch() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.idle != nil {
		t.idle.Reset(t.a.terminalIdle())
	}
}

func (a *API) terminalIdle() time.Duration {
	if a.opt.TerminalIdle > 0 {
		return a.opt.TerminalIdle
	}
	return DefaultTerminalIdle
}

func (a *API) terminalMax() time.Duration {
	if a.opt.TerminalMax > 0 {
		return a.opt.TerminalMax
	}
	return DefaultTerminalMax
}

// terminal is GET /api/servers/{uuid}/terminal (protocol in openapi.yaml).
func (a *API) terminal(w http.ResponseWriter, r *http.Request) {
	if !a.checkOrigin(r) {
		writeErr(w, http.StatusForbidden, "forbidden", "origin not allowed")
		return
	}
	up := websocket.Upgrader{ReadBufferSize: 8192, WriteBufferSize: 32768, CheckOrigin: a.checkOrigin}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	t := &termSession{a: a, conn: conn, uuid: r.PathValue("uuid")}
	defer t.close(websocket.CloseNormalClosure, "")
	conn.SetReadLimit(64 * 1024)

	// 1. auth binnen AuthTimeout
	_ = conn.SetReadDeadline(time.Now().Add(a.opt.AuthTimeout))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		var ne interface{ Timeout() bool }
		if errors.As(err, &ne) && ne.Timeout() {
			t.close(CloseAuthTimeout, "no auth within 10 s")
		}
		return
	}
	var first termIn
	if mt != websocket.TextMessage || json.Unmarshal(data, &first) != nil || first.Event != "auth" {
		t.close(CloseTokenInvalid, "send auth first")
		return
	}
	actx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	claims, code, why := a.verifyTerminal(actx, first.Token, t.uuid)
	cancel()
	if claims == nil {
		a.log.Debug("terminal: token refused", "why", why)
		t.close(code, why)
		return
	}
	if _, ok := a.mgr.Get(t.uuid); !ok {
		t.close(CloseUnknown, "server unknown")
		return
	}
	t.sub = claims.Subject

	// 2. shell starten
	octx, ocancel := context.WithTimeout(r.Context(), 2*time.Minute)
	sh, err := a.mgr.OpenShell(octx, t.uuid, first.Cols, first.Rows)
	ocancel()
	if err != nil {
		switch {
		case errors.Is(err, server.ErrTooManyShells):
			t.close(CloseTooMany, "too many open shells")
		case errors.Is(err, server.ErrNotFound):
			t.close(CloseUnknown, "server unknown")
		default:
			a.log.Warn("terminal: shell failed", "uuid", t.uuid, "err", err)
			t.send(server.Msg{"event": "error", "message": "shell could not be started: " + err.Error()})
			t.close(websocket.CloseInternalServerErr, "shell failed")
		}
		return
	}
	t.mu.Lock()
	t.shell = sh
	t.idle = time.AfterFunc(a.terminalIdle(), func() { t.close(CloseTerminalIdle, "idle timeout") })
	t.mu.Unlock()
	maxTimer := time.AfterFunc(a.terminalMax(), func() { t.close(CloseTerminalIdle, "session too long") })
	defer maxTimer.Stop()
	a.log.Info("terminal geopend", "uuid", t.uuid, "user", claims.Subject)
	t.arm(claims)
	t.send(server.Msg{"event": "auth_success"})

	// 3. uitvoer → websocket (binair)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := sh.Read(buf)
			if n > 0 {
				t.wmu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(20 * time.Second))
				werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n])
				t.wmu.Unlock()
				if werr != nil {
					t.close(websocket.CloseGoingAway, "")
					return
				}
			}
			if err != nil {
				break
			}
		}
		select {
		case <-sh.Done():
		case <-time.After(5 * time.Second):
		}
		t.send(server.Msg{"event": "terminal_exit", "code": sh.ExitCode()})
		t.close(websocket.CloseNormalClosure, "shell exited")
	}()

	// 4. invoer en besturing; keepalive met pings
	ping := time.NewTicker(a.opt.PingInterval)
	defer ping.Stop()
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case <-ping.C:
			}
			t.wmu.Lock()
			err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second))
			t.wmu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(3 * a.opt.PingInterval))
	})
	_ = conn.SetReadDeadline(time.Now().Add(3 * a.opt.PingInterval))
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(3 * a.opt.PingInterval))
		if mt == websocket.BinaryMessage {
			t.touch()
			if _, err := sh.Write(data); err != nil {
				return
			}
			continue
		}
		var in termIn
		if json.Unmarshal(data, &in) != nil {
			t.send(server.Msg{"event": "error", "message": "invalid JSON"})
			continue
		}
		switch in.Event {
		case "resize":
			if in.Cols > 0 && in.Rows > 0 {
				_ = sh.Resize(in.Cols, in.Rows)
			}
		case "auth":
			rctx, rcancel := context.WithTimeout(context.Background(), 10*time.Second)
			c, code, why := a.verifyTerminal(rctx, in.Token, t.uuid)
			rcancel()
			if c == nil {
				t.close(code, why)
				return
			}
			if c.Subject != t.sub {
				t.close(CloseTokenInvalid, "token belongs to another user")
				return
			}
			t.arm(c)
			t.send(server.Msg{"event": "auth_success"})
		default:
			t.send(server.Msg{"event": "error", "message": "unknown event " + in.Event})
		}
	}
}
