package server

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"

	"panel/daemon/internal/mcproto"
	"panel/daemon/internal/spec"
)

// StateSleeping: gestopt wegens geen spelers; de daemon luistert zelf op de poort.
const StateSleeping = "sleeping"

func pingAddr(a spec.Allocation) string {
	ip := a.IP
	if ip == "" || ip == "0.0.0.0" {
		ip = "127.0.0.1"
	}
	return net.JoinHostPort(ip, strconv.Itoa(a.Port))
}

// sleepLoop telt elke "minuut" de spelers van een server met slaapstand.
func (s *Server) sleepLoop() {
	t := time.NewTicker(s.m.cfg.SleepMinute)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
		}
		s.checkIdle()
	}
}

func (s *Server) checkIdle() {
	s.mu.Lock()
	sp, st, running := s.spec, s.state, s.run != nil
	if sp.Sleep == nil || st != StateOnline || !running || s.sleepPending {
		s.idleSince = time.Time{}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	a, ok := sp.Primary()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	n, err := s.m.cfg.Pinger(ctx, pingAddr(a))
	cancel()
	if err != nil {
		return // geen antwoord (nog aan het laden?): niets concluderen
	}
	s.mu.Lock()
	if n > 0 || s.state != StateOnline {
		s.idleSince = time.Time{}
		s.mu.Unlock()
		return
	}
	now := time.Now()
	if s.idleSince.IsZero() {
		s.idleSince = now
	}
	idle := now.Sub(s.idleSince) >= time.Duration(sp.Sleep.IdleMinutes)*s.m.cfg.SleepMinute
	if idle {
		s.sleepPending = true
	}
	s.mu.Unlock()
	if idle {
		go s.goToSleep(sp.Sleep.IdleMinutes)
	}
}

func (s *Server) goToSleep(minutes int) {
	s.DaemonMessage("info", fmt.Sprintf("No players for %d min: the server is going to sleep.", minutes))
	s.opMu.Lock()
	defer s.opMu.Unlock()
	err := s.doStop(false)
	s.mu.Lock()
	s.sleepPending = false
	sleeping := s.state == StateSleeping
	s.mu.Unlock()
	if err != nil {
		s.m.log.Warn("stopping for sleep mode failed", "uuid", s.uuid, "err", err)
	}
	if sleeping {
		s.startSleepListener()
	}
}

// startSleepListener bindt de primaire allocation (opMu vastgehouden of tijdens Recover).
// Lukt binden niet, dan gaat de server naar offline met een melding.
func (s *Server) startSleepListener() {
	s.mu.Lock()
	sp := s.spec
	have := s.sleepL != nil
	s.mu.Unlock()
	if have {
		return
	}
	a, ok := sp.Primary()
	if sp.Sleep == nil || !ok {
		s.setState(StateOffline)
		return
	}
	motd, kick := sp.Sleep.Texts()
	addr := net.JoinHostPort(a.IP, strconv.Itoa(a.Port))
	var lastErr error
	for i := 0; i < 10; i++ {
		l, err := mcproto.Listen(addr, &mcproto.Responder{MOTD: motd, Kick: kick, Wake: s.wake})
		if err == nil {
			s.mu.Lock()
			if s.state != StateSleeping || s.deleted {
				s.mu.Unlock()
				l.Close()
				return
			}
			s.sleepL = l
			s.mu.Unlock()
			return
		}
		lastErr = err
		select {
		case <-s.ctx.Done():
			return
		case <-time.After(500 * time.Millisecond): // docker-proxy laat de poort soms net later los
		}
	}
	s.m.log.Warn("sleep mode: binding port failed", "uuid", s.uuid, "addr", addr, "err", lastErr)
	s.DaemonMessage("warning", "Sleep mode: port "+addr+" is in use; the server is off and will not be woken automatically.")
	s.mu.Lock()
	if s.state == StateSleeping {
		s.setStateLocked(StateOffline)
	}
	s.mu.Unlock()
}

// stopSleepListener sluit de listener (poort vrij) als die er is.
func (s *Server) stopSleepListener() {
	s.mu.Lock()
	l := s.sleepL
	s.sleepL = nil
	s.mu.Unlock()
	if l != nil {
		l.Close()
	}
}

// wake: een speler probeert in te loggen.
func (s *Server) wake() {
	if s.State() != StateSleeping {
		return
	}
	s.DaemonMessage("info", "Connection attempt: waking the server.")
	if err := s.Power("start"); err != nil {
		s.m.log.Warn("waking failed", "uuid", s.uuid, "err", err)
	}
}

// SleepAddr geeft het adres van de slaapstand-listener ("" als die er niet is; voor tests).
func (s *Server) SleepAddr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sleepL == nil {
		return ""
	}
	return s.sleepL.Addr()
}
