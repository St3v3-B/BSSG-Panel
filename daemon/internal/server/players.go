package server

import (
	"context"
	"time"
)

// Players is het antwoord van GET /api/servers/{uuid}/players.
type Players struct {
	Online  *int    `json:"online"`
	Max     *int    `json:"max"`
	Version *string `json:"version"`
}

// PingTimeout is de maximale duur van een spelers-ping.
const PingTimeout = 2 * time.Second

// Players doet een server-list-ping naar de primaire allocation als de server online is.
// Geen antwoord (of niet online) geeft lege velden, geen fout.
func (s *Server) Players(ctx context.Context) Players {
	s.mu.Lock()
	sp, st, running := s.spec, s.state, s.run != nil
	s.mu.Unlock()
	if st != StateOnline || !running {
		return Players{}
	}
	a, ok := sp.Primary()
	if !ok {
		return Players{}
	}
	ctx, cancel := context.WithTimeout(ctx, PingTimeout)
	defer cancel()
	res, err := s.m.cfg.StatusPinger(ctx, pingAddr(a))
	if err != nil {
		return Players{}
	}
	online, max := res.Players.Online, res.Players.Max
	out := Players{Online: &online, Max: &max}
	if v := res.Version.Name; v != "" {
		if len(v) > 64 {
			v = v[:64]
		}
		out.Version = &v
	}
	return out
}
