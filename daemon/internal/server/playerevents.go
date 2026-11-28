package server

import (
	"regexp"
	"strings"
	"time"
	"unicode"

	"panel/daemon/internal/panel"
	"panel/daemon/internal/spec"
)

// PlayerReporter is optioneel naast Reporter: meldt join/leave van spelers (panel.Client doet het).
type PlayerReporter interface {
	ReportPlayerEvent(uuid string, ev panel.PlayerEvent)
}

// PlayerMatcher herkent join/leave/uuid-regels met de patronen uit de spec.
type PlayerMatcher struct {
	join, leave, uuid *regexp.Regexp
}

// Soorten regels die Match herkent.
const (
	PlayerJoin  = "join"
	PlayerLeave = "leave"
	PlayerUUID  = "uuid"
)

const maxPlayerName = 64

var playerUUIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$`)

// CompilePlayerEvents geeft nil als er geen (geldige) patronen zijn.
func CompilePlayerEvents(pe *spec.PlayerEvents) *PlayerMatcher {
	if pe == nil || pe.Join == "" || pe.Leave == "" {
		return nil
	}
	j, err1 := regexp.Compile(pe.Join)
	l, err2 := regexp.Compile(pe.Leave)
	if err1 != nil || err2 != nil || j.SubexpIndex("name") < 0 || l.SubexpIndex("name") < 0 {
		return nil
	}
	m := &PlayerMatcher{join: j, leave: l}
	if pe.UUID != "" {
		if u, err := regexp.Compile(pe.UUID); err == nil && u.SubexpIndex("name") >= 0 && u.SubexpIndex("uuid") >= 0 {
			m.uuid = u
		}
	}
	return m
}

func validPlayerName(n string) bool {
	if n == "" || len(n) > maxPlayerName {
		return false
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// Match bekijkt één consoleregel. kind is "" als de regel niets betekent. De patronen gelden voor
// de hele regel (zonder kleurcodes); chatregels beginnen met `<naam>` en matchen dus niet.
func (m *PlayerMatcher) Match(line string) (kind, name, id string) {
	if m == nil {
		return "", "", ""
	}
	l := strings.TrimRight(StripANSI(line), " \t\r")
	if len(l) > 1024 {
		return "", "", ""
	}
	try := func(re *regexp.Regexp, k string) bool {
		sm := re.FindStringSubmatch(l)
		if sm == nil {
			return false
		}
		n := sm[re.SubexpIndex("name")]
		if !validPlayerName(n) {
			return false
		}
		kind, name = k, n
		if i := re.SubexpIndex("uuid"); i >= 0 && playerUUIDRe.MatchString(sm[i]) {
			id = normPlayerUUID(sm[i])
		}
		return true
	}
	if try(m.join, PlayerJoin) || try(m.leave, PlayerLeave) {
		return kind, name, id
	}
	if m.uuid != nil && try(m.uuid, PlayerUUID) {
		if id == "" {
			return "", "", ""
		}
		return kind, name, id
	}
	return "", "", ""
}

func normPlayerUUID(s string) string {
	h := strings.ToLower(strings.ReplaceAll(s, "-", ""))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// maxPendingUUIDs begrenst de namen waarvan de UUID al bekend is maar de join nog niet kwam.
const maxPendingUUIDs = 256

func (s *Server) reportPlayer(ev panel.PlayerEvent) {
	if pr, ok := s.m.rep.(PlayerReporter); ok {
		pr.ReportPlayerEvent(s.uuid, ev)
	}
}

// playerLineLocked verwerkt een consoleregel voor de speleractiviteit (s.mu vastgehouden).
func (s *Server) playerLineLocked(line string) {
	kind, name, id := s.playerMatch.Match(line)
	if kind == "" {
		return
	}
	key := strings.ToLower(name)
	switch kind {
	case PlayerUUID:
		if s.pendingUUIDs == nil {
			s.pendingUUIDs = map[string]string{}
		}
		if len(s.pendingUUIDs) >= maxPendingUUIDs {
			clear(s.pendingUUIDs)
		}
		s.pendingUUIDs[key] = id
	case PlayerJoin:
		if id == "" {
			id = s.pendingUUIDs[key]
		}
		delete(s.pendingUUIDs, key)
		s.reportPlayer(panel.PlayerEvent{Type: PlayerJoin, At: time.Now().UTC(), Name: name, PlayerUUID: id})
	case PlayerLeave:
		reason := "leave"
		if s.sleepPending {
			reason = "sleep"
		} else if s.state == StateStopping {
			reason = "server_stop"
		}
		s.reportPlayer(panel.PlayerEvent{Type: PlayerLeave, At: time.Now().UTC(), Name: name, Reason: reason})
	}
}

// reportStopped meldt dat de server niet meer draait (open sessies sluiten). reason: server_stop, sleep of crash.
func (s *Server) reportStopped(reason string) {
	s.mu.Lock()
	has := s.playerMatch != nil
	clear(s.pendingUUIDs)
	s.mu.Unlock()
	if has {
		s.reportPlayer(panel.PlayerEvent{Type: "stopped", At: time.Now().UTC(), Reason: reason})
	}
}
