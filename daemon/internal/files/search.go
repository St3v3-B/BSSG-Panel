package files

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// Grenzen voor Search.
const (
	SearchDefaultLimit    = 200
	SearchMaxLimit        = 1000
	SearchMaxFileBytes    = 1 << 20 // inhoud: alleen tekstbestanden tot 1 MB
	searchMaxDepth        = 64
	searchMatchesPerFile  = 5
	searchMaxLineRunes    = 300
	searchBinarySniffSize = 8000
)

// SearchOptions bepaalt wat Search zoekt.
type SearchOptions struct {
	Dir     string // startmap (API-pad)
	Query   string // naam: deel van de naam of glob (* en ?); inhoud: letterlijke tekst
	Content bool   // in de inhoud zoeken in plaats van in de naam
	Limit   int    // max aantal resultaten (0 = standaard)
}

// SearchMatch is één gevonden regel bij zoeken op inhoud.
type SearchMatch struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

// SearchHit is één resultaat.
type SearchHit struct {
	Entry   Entry         `json:"entry"`
	Matches []SearchMatch `json:"matches"`
}

// SearchResult is het SearchResult-schema uit openapi.yaml.
type SearchResult struct {
	Results   []SearchHit `json:"results"`
	Truncated bool        `json:"truncated"`
	TimedOut  bool        `json:"timed_out"`
}

var errSearchStop = errors.New("stop")

// Search zoekt recursief onder opt.Dir. Symlinks worden nooit gevolgd (wel op naam gevonden);
// het zoeken stopt bij opt.Limit resultaten of als ctx afloopt (TimedOut, met wat er al is).
func (r *Root) Search(ctx context.Context, opt SearchOptions) (SearchResult, error) {
	res := SearchResult{Results: []SearchHit{}}
	q := strings.TrimSpace(opt.Query)
	if q == "" || len(q) > 200 || strings.ContainsRune(q, 0) {
		return res, ErrBadPath
	}
	limit := opt.Limit
	if limit <= 0 {
		limit = SearchDefaultLimit
	}
	if limit > SearchMaxLimit {
		limit = SearchMaxLimit
	}
	rel, err := Clean(opt.Dir)
	if err != nil {
		return res, err
	}
	root, err := r.rootFD()
	if err != nil {
		return res, err
	}
	defer unix.Close(root)
	start, err := openBeneath(root, rel, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return res, err
	}
	s := &searcher{ctx: ctx, root: root, limit: limit, content: opt.Content, res: &res}
	lq := strings.ToLower(q)
	if opt.Content {
		s.needle = []byte(lq)
	} else if strings.ContainsAny(lq, "*?[") {
		if _, err := path.Match(lq, ""); err != nil {
			unix.Close(start)
			return res, ErrBadPath
		}
		s.match = func(name string) bool { ok, _ := path.Match(lq, strings.ToLower(name)); return ok }
	} else {
		s.match = func(name string) bool { return strings.Contains(strings.ToLower(name), lq) }
	}
	err = s.walk(start, rel, 0) // sluit start
	if errors.Is(err, errSearchStop) {
		err = nil
	}
	return res, err
}

type searcher struct {
	ctx     context.Context
	root    int
	limit   int
	content bool
	needle  []byte
	match   func(name string) bool
	res     *SearchResult
}

func (s *searcher) add(h SearchHit) error {
	if len(s.res.Results) >= s.limit {
		s.res.Truncated = true
		return errSearchStop
	}
	if h.Matches == nil {
		h.Matches = []SearchMatch{}
	}
	s.res.Results = append(s.res.Results, h)
	return nil
}

// walk doorzoekt de map dirfd (eigendom van walk: wordt gesloten).
func (s *searcher) walk(dirfd int, dirRel string, depth int) error {
	f := os.NewFile(uintptr(dirfd), dirRel)
	names, err := f.Readdirnames(-1)
	if err != nil {
		f.Close()
		return nil // onleesbare map: overslaan
	}
	sort.Strings(names)
	defer f.Close()
	for _, name := range names {
		if s.ctx.Err() != nil {
			s.res.TimedOut = true
			return errSearchStop
		}
		var st unix.Stat_t
		if unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		rel := name
		if dirRel != "." {
			rel = dirRel + "/" + name
		}
		kind := st.Mode & unix.S_IFMT
		if !s.content && s.match(name) {
			e, _, err := entryAt(s.root, dirfd, dirRel, name)
			if err == nil {
				if err := s.add(SearchHit{Entry: e}); err != nil {
					return err
				}
			}
		}
		switch kind {
		case unix.S_IFDIR:
			if depth >= searchMaxDepth {
				continue
			}
			sub, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				continue
			}
			if err := s.walk(sub, rel, depth+1); err != nil {
				return err
			}
		case unix.S_IFREG:
			if !s.content || st.Size > SearchMaxFileBytes {
				continue
			}
			matches := s.grep(dirfd, name)
			if len(matches) == 0 {
				continue
			}
			e, _, err := entryAt(s.root, dirfd, dirRel, name)
			if err != nil {
				continue
			}
			if err := s.add(SearchHit{Entry: e, Matches: matches}); err != nil {
				return err
			}
		}
	}
	return nil
}

// grep zoekt de needle (hoofdletterongevoelig) per regel in een tekstbestand.
func (s *searcher) grep(dirfd int, name string) []SearchMatch {
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, SearchMaxFileBytes))
	if err != nil {
		return nil
	}
	sniff := data
	if len(sniff) > searchBinarySniffSize {
		sniff = sniff[:searchBinarySniffSize]
	}
	if bytes.IndexByte(sniff, 0) >= 0 {
		return nil // binair
	}
	if !bytes.Contains(bytes.ToLower(data), s.needle) {
		return nil
	}
	var out []SearchMatch
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), SearchMaxFileBytes+1)
	for n := 1; sc.Scan(); n++ {
		line := sc.Bytes()
		idx := bytes.Index(bytes.ToLower(line), s.needle)
		if idx < 0 {
			continue
		}
		out = append(out, SearchMatch{Line: n, Text: snippet(line, idx)})
		if len(out) >= searchMatchesPerFile {
			break
		}
	}
	return out
}

// snippet geeft de regel, ingekort tot searchMaxLineRunes rond de treffer op byte idx.
func snippet(line []byte, idx int) string {
	line = bytes.TrimRight(line, "\r")
	repl := []byte("�")
	if utf8.RuneCount(line) <= searchMaxLineRunes {
		return string(bytes.ToValidUTF8(line, repl))
	}
	start, prefix := idx-80, "…"
	if start <= 0 {
		start, prefix = 0, ""
	}
	if start > len(line) {
		start = len(line)
	}
	for start > 0 && start < len(line) && !utf8.RuneStart(line[start]) {
		start--
	}
	r := []rune(string(bytes.ToValidUTF8(line[start:], repl)))
	if len(r) > searchMaxLineRunes {
		return prefix + string(r[:searchMaxLineRunes]) + "…"
	}
	return prefix + string(r)
}
