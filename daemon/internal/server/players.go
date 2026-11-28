package server

import (
	"context"
	"regexp"
	"strings"
	"time"
)

var (
	sampleName = regexp.MustCompile(`^\.?[A-Za-z0-9_]{1,16}$`)
	sampleID   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

func validSampleName(s string) bool { return sampleName.MatchString(s) }
func validSampleID(s string) bool   { return sampleID.MatchString(s) }

// Players is het antwoord van GET /api/servers/{uuid}/players.
type Players struct {
	Online  *int    `json:"online"`
	Max     *int    `json:"max"`
	Version *string `json:"version"`
	// Sample is de spelerslijst uit het ping-antwoord (meestal max 12 spelers; anonieme spelers
	// hebben een nul-UUID). Leeg als er geen antwoord is.
	Sample []PlayerSample `json:"sample"`
}

// PlayerSample is één speler uit het ping-antwoord.
type PlayerSample struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

// MaxSample is het maximum aantal spelers dat Players doorgeeft.
const MaxSample = 100

// PingTimeout is de maximale duur van een spelers-ping.
const PingTimeout = 2 * time.Second

// Players doet een server-list-ping naar de primaire allocation als de server online is.
// Geen antwoord (of niet online) geeft lege velden, geen fout.
func (s *Server) Players(ctx context.Context) Players {
	s.mu.Lock()
	sp, st, running := s.spec, s.state, s.run != nil
	s.mu.Unlock()
	if st != StateOnline || !running {
		return Players{Sample: []PlayerSample{}}
	}
	a, ok := sp.Primary()
	if !ok {
		return Players{Sample: []PlayerSample{}}
	}
	ctx, cancel := context.WithTimeout(ctx, PingTimeout)
	defer cancel()
	res, err := s.m.cfg.StatusPinger(ctx, pingAddr(a))
	if err != nil {
		return Players{Sample: []PlayerSample{}}
	}
	online, max := res.Players.Online, res.Players.Max
	out := Players{Online: &online, Max: &max, Sample: []PlayerSample{}}
	for _, p := range res.Players.Sample {
		if len(out.Sample) >= MaxSample {
			break
		}
		// Alleen geldige namen/UUID's: het ping-antwoord komt uit de container.
		if !validSampleName(p.Name) || !validSampleID(p.ID) {
			continue
		}
		out.Sample = append(out.Sample, PlayerSample{Name: p.Name, ID: strings.ToLower(p.ID)})
	}
	if v := res.Version.Name; v != "" {
		if len(v) > 64 {
			v = v[:64]
		}
		out.Version = &v
	}
	return out
}
