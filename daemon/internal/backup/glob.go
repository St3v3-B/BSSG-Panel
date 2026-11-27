package backup

import (
	"regexp"
	"strings"
)

// Ignore beoordeelt paden (relatief aan de root, met /) tegen glob-patronen:
// `*` en `?` blijven binnen één padsegment, `**` loopt over segmenten. Een patroon
// zonder `/` geldt voor elke diepte; een patroon dat een map raakt sluit alles eronder uit.
type Ignore struct{ res []*regexp.Regexp }

// NewIgnore compileert patronen; ongeldige of lege patronen worden overgeslagen.
func NewIgnore(patterns []string) *Ignore {
	ig := &Ignore{}
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		p = strings.TrimPrefix(p, "./")
		anchored := strings.HasPrefix(p, "/")
		p = strings.Trim(p, "/")
		if p == "" {
			continue
		}
		if !anchored && !strings.Contains(p, "/") {
			p = "**/" + p
		}
		var b strings.Builder
		b.WriteString("^")
		for i := 0; i < len(p); i++ {
			switch c := p[i]; c {
			case '*':
				if i+1 < len(p) && p[i+1] == '*' {
					i++
					if i+1 < len(p) && p[i+1] == '/' {
						i++
						b.WriteString("(?:.*/)?")
					} else {
						b.WriteString(".*")
					}
				} else {
					b.WriteString("[^/]*")
				}
			case '?':
				b.WriteString("[^/]")
			default:
				b.WriteString(regexp.QuoteMeta(string(c)))
			}
		}
		b.WriteString("$")
		if re, err := regexp.Compile(b.String()); err == nil {
			ig.res = append(ig.res, re)
		}
	}
	return ig
}

// Match meldt of rel (of een van zijn bovenliggende mappen) wordt uitgesloten.
func (ig *Ignore) Match(rel string) bool {
	if ig == nil || len(ig.res) == 0 {
		return false
	}
	for p := rel; p != "" && p != "."; {
		for _, re := range ig.res {
			if re.MatchString(p) {
				return true
			}
		}
		i := strings.LastIndexByte(p, '/')
		if i < 0 {
			break
		}
		p = p[:i]
	}
	return false
}
