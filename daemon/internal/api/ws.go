package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"panel/daemon/internal/auth"
	"panel/daemon/internal/server"
)

// Sluitcodes uit openapi.yaml.
const (
	CloseTokenInvalid = 4001
	CloseNoConsole    = 4003
	CloseUnknown      = 4004
	CloseAuthTimeout  = 4008
)

func (a *API) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // geen browser
	}
	for _, o := range a.opt.AllowedOrigins {
		if o != "" && strings.EqualFold(origin, o) {
			return true
		}
	}
	return false
}

type session struct {
	a    *API
	conn *websocket.Conn
	sub  *server.Sub
	uuid string

	mu         sync.Mutex
	claims     *auth.Claims
	srv        *server.Server
	subscribed bool
	warn, exp  *time.Timer

	done    chan struct{}
	closing atomic.Bool
}

type wsIn struct {
	Event   string `json:"event"`
	Token   string `json:"token"`
	Command string `json:"command"`
	State   string `json:"state"`
}

func msg(v server.Msg) []byte {
	b, _ := json.Marshal(v)
	return b
}

func (a *API) websocket(w http.ResponseWriter, r *http.Request) {
	up := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 16384,
		CheckOrigin:     a.checkOrigin,
	}
	if !a.checkOrigin(r) {
		writeErr(w, http.StatusForbidden, "forbidden", "origin niet toegestaan")
		return
	}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade heeft al geantwoord
	}
	s := &session{a: a, conn: conn, sub: server.NewSub(), uuid: r.PathValue("uuid"), done: make(chan struct{})}
	a.wsMu.Lock()
	a.wsConn[s] = struct{}{}
	a.wsMu.Unlock()
	go s.writer()
	s.reader()
}

// CloseAll sluit alle websockets (bij het stoppen van de daemon).
func (a *API) CloseAll() {
	a.wsMu.Lock()
	defer a.wsMu.Unlock()
	for s := range a.wsConn {
		s.sub.Close(websocket.CloseGoingAway, "daemon stopt")
	}
}

func (s *session) writer() {
	ping := time.NewTicker(s.a.opt.PingInterval)
	defer ping.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ping.C:
			if err := s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
				s.conn.Close()
				return
			}
		case <-s.sub.Notify:
			for _, o := range s.sub.Drain() {
				if o.CloseCode > 0 {
					_ = s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(o.CloseCode, o.CloseText), time.Now().Add(5*time.Second))
					s.closing.Store(true)
					// De client antwoordt met een close-frame; de reader stopt dan. Anders na 2 s.
					_ = s.conn.UnderlyingConn().SetReadDeadline(time.Now().Add(2 * time.Second))
					return
				}
				_ = s.conn.SetWriteDeadline(time.Now().Add(20 * time.Second))
				if err := s.conn.WriteMessage(websocket.TextMessage, o.Data); err != nil {
					s.conn.Close()
					return
				}
			}
		}
	}
}

func (s *session) cleanup() {
	close(s.done)
	s.mu.Lock()
	if s.warn != nil {
		s.warn.Stop()
	}
	if s.exp != nil {
		s.exp.Stop()
	}
	srv := s.srv
	s.mu.Unlock()
	if srv != nil {
		srv.Unsubscribe(s.sub)
	}
	s.a.wsMu.Lock()
	delete(s.a.wsConn, s)
	s.a.wsMu.Unlock()
	s.conn.Close()
}

func (s *session) authed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.claims != nil
}

func (s *session) reader() {
	defer s.cleanup()
	s.conn.SetReadLimit(64 * 1024)
	_ = s.conn.SetReadDeadline(time.Now().Add(s.a.opt.AuthTimeout))
	s.conn.SetPongHandler(func(string) error {
		if s.authed() && !s.closing.Load() {
			_ = s.conn.SetReadDeadline(time.Now().Add(3 * s.a.opt.PingInterval))
		}
		return nil
	})
	for {
		_, data, err := s.conn.ReadMessage()
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() && !s.authed() {
				_ = s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(CloseAuthTimeout, "geen auth binnen 10 s"), time.Now().Add(2*time.Second))
			}
			return
		}
		var in wsIn
		if err := json.Unmarshal(data, &in); err != nil {
			s.sub.Send(msg(server.Msg{"event": "error", "message": "ongeldige JSON"}))
			continue
		}
		if in.Event == "auth" {
			if s.auth(in.Token) && !s.closing.Load() {
				_ = s.conn.SetReadDeadline(time.Now().Add(3 * s.a.opt.PingInterval))
			}
			continue
		}
		s.mu.Lock()
		claims, srv := s.claims, s.srv
		s.mu.Unlock()
		if claims == nil {
			s.sub.Close(CloseTokenInvalid, "eerst auth sturen")
			continue
		}
		switch in.Event {
		case "send_command":
			if !claims.Has("console.write") {
				s.sub.Send(msg(server.Msg{"event": "error", "message": "recht console.write ontbreekt"}))
				continue
			}
			if in.Command == "" || len(in.Command) > 2000 || strings.ContainsAny(in.Command, "\r\n") {
				s.sub.Send(msg(server.Msg{"event": "error", "message": "ongeldig commando"}))
				continue
			}
			if err := srv.SendCommand(in.Command); err != nil {
				s.sub.Send(msg(server.Msg{"event": "error", "message": err.Error()}))
			}
		case "set_state":
			if !claims.Has("power") {
				s.sub.Send(msg(server.Msg{"event": "error", "message": "recht power ontbreekt"}))
				continue
			}
			if !powerActions[in.State] {
				s.sub.Send(msg(server.Msg{"event": "error", "message": "state moet start, stop, restart of kill zijn"}))
				continue
			}
			if err := srv.Power(in.State); err != nil {
				s.sub.Send(msg(server.Msg{"event": "error", "message": err.Error()}))
			}
		case "request_stats":
			s.sub.Send(srv.StatsMessage())
		default:
			s.sub.Send(msg(server.Msg{"event": "error", "message": "onbekend event " + in.Event}))
		}
	}
}

// auth verwerkt een (nieuw) token. Bij een fout zet hij een sluitopdracht in de wachtrij.
func (s *session) auth(token string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	claims, err := s.a.jwt.Verify(ctx, token)
	if err != nil {
		s.a.log.Debug("ws: token afgewezen", "err", err)
		s.sub.Close(CloseTokenInvalid, "token ongeldig")
		return false
	}
	srv, ok := s.a.mgr.Get(s.uuid)
	if !ok {
		s.sub.Close(CloseUnknown, "server onbekend")
		return false
	}
	if !strings.EqualFold(claims.ServerUUID, srv.UUID()) {
		s.sub.Close(CloseTokenInvalid, "token hoort bij een andere server")
		return false
	}
	if !claims.Has("console.read") {
		s.sub.Close(CloseNoConsole, "recht console.read ontbreekt")
		return false
	}
	s.mu.Lock()
	if s.claims != nil && s.claims.Subject != claims.Subject {
		s.mu.Unlock()
		s.sub.Close(CloseTokenInvalid, "token hoort bij een andere gebruiker")
		return false
	}
	s.claims = claims
	s.srv = srv
	if s.warn != nil {
		s.warn.Stop()
	}
	if s.exp != nil {
		s.exp.Stop()
	}
	exp := claims.ExpiresAt.Time
	expMsg := msg(server.Msg{"event": "token_expiring", "expires_at": exp.UTC().Format(time.RFC3339)})
	s.warn = time.AfterFunc(max(time.Until(exp)-time.Minute, 0), func() { s.sub.Send(expMsg) })
	s.exp = time.AfterFunc(max(time.Until(exp), 0), func() {
		s.sub.Send(msg(server.Msg{"event": "token_expired"}))
		s.sub.Close(CloseTokenInvalid, "token verlopen")
	})
	first := !s.subscribed
	s.subscribed = true
	s.mu.Unlock()

	perms := claims.Permissions
	if perms == nil {
		perms = []string{}
	}
	success := msg(server.Msg{"event": "auth_success", "permissions": perms})
	if first {
		if !srv.Subscribe(s.sub, success) {
			s.sub.Close(CloseUnknown, "server onbekend")
			return false
		}
	} else {
		s.sub.Send(success)
	}
	return true
}
