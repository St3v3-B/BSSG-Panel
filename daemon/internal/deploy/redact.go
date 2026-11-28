package deploy

import (
	"encoding/base64"
	"regexp"
	"strings"
	"sync"
)

// userinfoRe vangt inloggegevens in URL's die in uitvoer opduiken (scheme://user:pw@host).
var userinfoRe = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s:]+:[^/@\s]+@`)

// Redactor haalt geheimen uit logregels.
type Redactor struct{ secrets []string }

// NewRedactor maakt een redactor voor deze geheimen (ook hun base64-vormen, zoals in een Basic-header).
func NewRedactor(user string, secrets ...string) *Redactor {
	r := &Redactor{}
	for _, s := range secrets {
		s = strings.TrimSpace(s)
		if len(s) < 4 {
			continue
		}
		r.secrets = append(r.secrets, s, base64.StdEncoding.EncodeToString([]byte(user+":"+s)))
		// Ook elke regel van een meerregelig geheim (privésleutel).
		for _, l := range strings.Split(s, "\n") {
			if l = strings.TrimSpace(l); len(l) >= 16 && !strings.HasPrefix(l, "-----") {
				r.secrets = append(r.secrets, l)
			}
		}
	}
	return r
}

// Line geeft de regel zonder geheimen en zonder control characters (behalve tab).
func (r *Redactor) Line(s string) string {
	for _, sec := range r.secrets {
		if sec != "" {
			s = strings.ReplaceAll(s, sec, "***")
		}
	}
	s = userinfoRe.ReplaceAllString(s, "${1}***@")
	s = strings.Map(func(c rune) rune {
		if c == '\t' || c >= 0x20 && c != 0x7f {
			return c
		}
		return -1
	}, s)
	if len(s) > 2000 {
		s = s[:2000] + "…"
	}
	return s
}

// ring bewaart de laatste n regels.
type ring struct {
	mu    sync.Mutex
	n     int
	lines []string
}

func newRing(n int) *ring { return &ring{n: n} }

func (r *ring) add(l string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, l)
	if len(r.lines) > r.n {
		r.lines = append([]string(nil), r.lines[len(r.lines)-r.n:]...)
	}
}

func (r *ring) tail(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || n > len(r.lines) {
		n = len(r.lines)
	}
	return append([]string{}, r.lines[len(r.lines)-n:]...)
}
