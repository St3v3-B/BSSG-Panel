package server

import (
	"bufio"
	"io"
	"regexp"
	"strings"
	"sync"
)

// Ring bewaart de laatste N regels.
type Ring struct {
	lines []string
	start int
	n     int
}

// NewRing maakt een ring buffer van size regels.
func NewRing(size int) *Ring { return &Ring{lines: make([]string, size)} }

// Add voegt een regel toe en gooit zo nodig de oudste weg.
func (r *Ring) Add(s string) {
	if len(r.lines) == 0 {
		return
	}
	if r.n < len(r.lines) {
		r.lines[(r.start+r.n)%len(r.lines)] = s
		r.n++
		return
	}
	r.lines[r.start] = s
	r.start = (r.start + 1) % len(r.lines)
}

// Last geeft de laatste n regels (oudste eerst); n <= 0 = alles.
func (r *Ring) Last(n int) []string {
	if n <= 0 || n > r.n {
		n = r.n
	}
	out := make([]string, 0, n)
	for i := r.n - n; i < r.n; i++ {
		out = append(out, r.lines[(r.start+i)%len(r.lines)])
	}
	return out
}

// Reset leegt de ring.
func (r *Ring) Reset() { r.start, r.n = 0, 0 }

// Len is het aantal regels.
func (r *Ring) Len() int { return r.n }

// Outgoing is één bericht in de wachtrij van een abonnee.
type Outgoing struct {
	Data      []byte
	CloseCode int // als > 0: na eerdere berichten de verbinding sluiten met deze code
	CloseText string
}

// MaxQueue is het maximale aantal berichten dat op één trage client wacht; daarboven
// vallen de oudste berichten weg.
const MaxQueue = 4096

// Sub is een abonnee (een websocket-verbinding) met een eigen, niet-blokkerende wachtrij.
type Sub struct {
	mu      sync.Mutex
	q       []Outgoing
	closed  bool
	Notify  chan struct{}
	Dropped int
}

// NewSub maakt een abonnee.
func NewSub() *Sub { return &Sub{Notify: make(chan struct{}, 1)} }

func (s *Sub) push(o Outgoing) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if o.CloseCode > 0 {
		s.closed = true
	}
	if len(s.q) >= MaxQueue {
		s.q = s.q[1:]
		s.Dropped++
	}
	s.q = append(s.q, o)
	s.mu.Unlock()
	select {
	case s.Notify <- struct{}{}:
	default:
	}
}

// Send zet een bericht in de wachtrij.
func (s *Sub) Send(data []byte) { s.push(Outgoing{Data: data}) }

// Close zet een sluitopdracht in de wachtrij; daarna worden berichten genegeerd.
func (s *Sub) Close(code int, text string) { s.push(Outgoing{CloseCode: code, CloseText: text}) }

// Drain haalt alle wachtende berichten op.
func (s *Sub) Drain() []Outgoing {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.q
	s.q = nil
	return q
}

var ansiRe = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]")

// StripANSI haalt kleurcodes weg (voor het ready-patroon).
func StripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	return ansiRe.ReplaceAllString(s, "")
}

// maxLine: langere regels worden in stukken gesplitst.
const maxLine = 16 * 1024

// readLines leest r regel voor regel (zonder \r\n) tot EOF of fout.
func readLines(r io.Reader, fn func(string)) {
	br := bufio.NewReaderSize(r, maxLine)
	var partial []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 {
			partial = append(partial, chunk...)
			if chunk[len(chunk)-1] == '\n' || len(partial) >= maxLine {
				fn(strings.TrimRight(string(partial), "\r\n"))
				partial = partial[:0]
			}
		}
		if err != nil && err != bufio.ErrBufferFull {
			if len(partial) > 0 {
				fn(strings.TrimRight(string(partial), "\r\n"))
			}
			return
		}
	}
}
