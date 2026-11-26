package spec

import (
	"regexp"
	"strconv"
	"strings"
)

// UpdateTOML zet geneste sleutels (met punten, bv. "servers.lobby") in een TOML-bestand en
// laat de rest (commentaar, volgorde, opmaak) staan. Een bestaande waarde houdt zijn type:
// stond er een string, dan wordt het weer een string; een getal of bool blijft dat als de
// nieuwe waarde er een is. Ontbrekende sleutels komen achteraan in hun tabel, of in een
// nieuwe [tabel] onderaan. Sleutels in [[array-tabellen]] worden niet aangeraakt.
func UpdateTOML(old []byte, set map[string]string) []byte {
	lines := strings.Split(string(old), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	done := map[string]bool{}
	// tableEnd[t] = index na de laatste niet-lege regel van tabel t ("" = root).
	tableEnd := map[string]int{"": 0}
	var tables []string
	cur, inArray := "", false
	rootEnd := 0
	for i := 0; i < len(lines); i++ {
		trim := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trim, "[") {
			if segs, arr, ok := parseHeader(trim); ok {
				cur, inArray = strings.Join(segs, "."), arr
				if !arr {
					if _, seen := tableEnd[cur]; !seen {
						tables = append(tables, cur)
					}
					tableEnd[cur] = i + 1
				}
				continue
			}
		}
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		segs, valStart, ok := parseKey(lines[i])
		if !ok {
			continue
		}
		end := valueEnd(lines, i, valStart)
		if !inArray {
			full := strings.Join(segs, ".")
			if cur != "" {
				full = cur + "." + full
			}
			if v, want := set[full]; want && !done[full] {
				done[full] = true
				oldVal := strings.TrimSpace(joinSpan(lines, i, valStart, end))
				comment := trailingComment(lines[end.line][end.col:])
				newLine := lines[i][:valStart] + formatTOML(v, oldVal) + comment
				lines = append(lines[:i], append([]string{newLine}, lines[end.line+1:]...)...)
				end.line = i
			}
			if cur == "" {
				rootEnd = end.line + 1
			} else {
				tableEnd[cur] = end.line + 1
			}
		}
		i = end.line
	}
	tableEnd[""] = rootEnd

	// Ontbrekende sleutels.
	type ins struct {
		at    int
		lines []string
	}
	var inserts []ins
	newTables := map[string][]string{}
	var newOrder []string
	for _, k := range sortedKeys(set) {
		if done[k] {
			continue
		}
		parts := strings.Split(k, ".")
		best := -1
		for ti, t := range tables {
			if strings.HasPrefix(k, t+".") && (best < 0 || len(t) > len(tables[best])) {
				best = ti
			}
		}
		switch {
		case best >= 0:
			t := tables[best]
			rest := strings.Split(strings.TrimPrefix(k, t+"."), ".")
			inserts = append(inserts, ins{tableEnd[t], []string{tomlKey(rest) + " = " + formatTOML(set[k], "")}})
		case len(parts) == 1:
			inserts = append(inserts, ins{tableEnd[""], []string{tomlKey(parts) + " = " + formatTOML(set[k], "")}})
		default:
			t := strings.Join(parts[:len(parts)-1], ".")
			if _, ok := newTables[t]; !ok {
				newOrder = append(newOrder, t)
			}
			newTables[t] = append(newTables[t], tomlKey(parts[len(parts)-1:])+" = "+formatTOML(set[k], ""))
		}
	}
	// Per positie groeperen en van achter naar voren invoegen, zodat de indexen kloppen.
	byPos := map[int][]string{}
	var positions []int
	for _, in := range inserts {
		if _, ok := byPos[in.at]; !ok {
			positions = append(positions, in.at)
		}
		byPos[in.at] = append(byPos[in.at], in.lines...)
	}
	for i := 0; i < len(positions); i++ {
		for j := i + 1; j < len(positions); j++ {
			if positions[j] > positions[i] {
				positions[i], positions[j] = positions[j], positions[i]
			}
		}
	}
	for _, at := range positions {
		add := byPos[at]
		lines = append(lines[:at], append(append([]string{}, add...), lines[at:]...)...)
	}
	for _, t := range newOrder {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		lines = append(lines, "["+tomlKey(strings.Split(t, "."))+"]")
		lines = append(lines, newTables[t]...)
	}
	if len(lines) == 0 {
		return []byte{}
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

var bareKey = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func tomlKey(segs []string) string {
	out := make([]string, len(segs))
	for i, s := range segs {
		if bareKey.MatchString(s) {
			out[i] = s
		} else {
			out[i] = strconv.Quote(s)
		}
	}
	return strings.Join(out, ".")
}

// parseKeySegs leest een (gestippelde) sleutel vanaf s[i]; stopt bij stop.
func parseKeySegs(s string, i int, stop byte) ([]string, int, bool) {
	var segs []string
	for {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i >= len(s) {
			return nil, 0, false
		}
		switch s[i] {
		case '"':
			j := i + 1
			var b strings.Builder
			for ; j < len(s) && s[j] != '"'; j++ {
				if s[j] == '\\' && j+1 < len(s) {
					j++
				}
				b.WriteByte(s[j])
			}
			if j >= len(s) {
				return nil, 0, false
			}
			segs = append(segs, b.String())
			i = j + 1
		case '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, 0, false
			}
			segs = append(segs, s[i+1:i+1+j])
			i = i + 2 + j
		default:
			j := i
			for j < len(s) && (bareKey.MatchString(string(s[j]))) {
				j++
			}
			if j == i {
				return nil, 0, false
			}
			segs = append(segs, s[i:j])
			i = j
		}
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i < len(s) && s[i] == '.' {
			i++
			continue
		}
		if i < len(s) && s[i] == stop {
			return segs, i + 1, true
		}
		return nil, 0, false
	}
}

func parseHeader(trim string) ([]string, bool, bool) {
	arr := strings.HasPrefix(trim, "[[")
	start := 1
	if arr {
		start = 2
	}
	segs, n, ok := parseKeySegs(trim, start, ']')
	if !ok {
		return nil, false, false
	}
	if arr {
		if n >= len(trim) || trim[n] != ']' {
			return nil, false, false
		}
		n++
	}
	rest := strings.TrimSpace(trim[n:])
	if rest != "" && !strings.HasPrefix(rest, "#") {
		return nil, false, false
	}
	return segs, arr, true
}

// parseKey geeft de sleutel van "key = waarde" en de index waar de waarde begint
// (na "= " en spaties).
func parseKey(line string) ([]string, int, bool) {
	segs, n, ok := parseKeySegs(line, 0, '=')
	if !ok {
		return nil, 0, false
	}
	for n < len(line) && (line[n] == ' ' || line[n] == '\t') {
		n++
	}
	return segs, n, true
}

type pos struct{ line, col int }

// valueEnd vindt het einde van de waarde die op lines[li][start:] begint (ook over
// meerdere regels: arrays, inline tables, """ en ”').
func valueEnd(lines []string, li, start int) pos {
	s := lines[li]
	if start >= len(s) {
		return pos{li, len(s)}
	}
	for _, q := range []string{`"""`, `'''`} {
		if strings.HasPrefix(s[start:], q) {
			if j := strings.Index(s[start+3:], q); j >= 0 {
				return pos{li, start + 3 + j + 3}
			}
			for l := li + 1; l < len(lines); l++ {
				if j := strings.Index(lines[l], q); j >= 0 {
					return pos{l, j + 3}
				}
			}
			return pos{len(lines) - 1, len(lines[len(lines)-1])}
		}
	}
	depth := 0
	l, i := li, start
	for l < len(lines) {
		s := lines[l]
		for i < len(s) {
			c := s[i]
			switch {
			case c == '"':
				i++
				for i < len(s) && s[i] != '"' {
					if s[i] == '\\' {
						i++
					}
					i++
				}
			case c == '\'':
				i++
				for i < len(s) && s[i] != '\'' {
					i++
				}
			case c == '[' || c == '{':
				depth++
			case c == ']' || c == '}':
				depth--
				if depth == 0 {
					return pos{l, i + 1}
				}
			case c == '#':
				if depth == 0 {
					return pos{l, i}
				}
				i = len(s)
				continue
			}
			i++
		}
		if depth == 0 {
			return pos{l, len(s)}
		}
		l++
		i = 0
	}
	return pos{len(lines) - 1, len(lines[len(lines)-1])}
}

func joinSpan(lines []string, li, start int, end pos) string {
	if end.line == li {
		return lines[li][start:end.col]
	}
	parts := []string{lines[li][start:]}
	for l := li + 1; l < end.line; l++ {
		parts = append(parts, lines[l])
	}
	parts = append(parts, lines[end.line][:end.col])
	return strings.Join(parts, "\n")
}

func trailingComment(rest string) string {
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		return " " + rest[i:]
	}
	return ""
}

var tomlNumber = regexp.MustCompile(`^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$`)

// formatTOML schrijft v in het type van oldVal ("" = nieuw: raden).
func formatTOML(v, oldVal string) string {
	isNum := tomlNumber.MatchString(v)
	isBool := v == "true" || v == "false"
	switch {
	case strings.HasPrefix(oldVal, `"`) || strings.HasPrefix(oldVal, `'`):
		return strconv.Quote(v)
	case oldVal == "true" || oldVal == "false":
		if isBool {
			return v
		}
	case tomlNumber.MatchString(oldVal):
		if isNum {
			return v
		}
	case strings.HasPrefix(oldVal, "[") || strings.HasPrefix(oldVal, "{"):
		if strings.HasPrefix(v, "[") || strings.HasPrefix(v, "{") {
			return v
		}
	case oldVal == "":
		if isNum || isBool {
			return v
		}
		if (strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]")) || (strings.HasPrefix(v, "{") && strings.HasSuffix(v, "}")) {
			return v
		}
	}
	return strconv.Quote(v)
}
