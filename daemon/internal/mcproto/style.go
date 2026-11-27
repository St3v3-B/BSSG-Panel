package mcproto

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Opmaak van het slaap-antwoord: tweeregelige MOTD als JSON-tekstcomponent, spelerslijst met
// hint en een 64x64 favicon.

const (
	// DefaultPromo is de standaard tweede regel.
	DefaultPromo = "&e⚡ &fJoin to wake it up &8• &7Hosted on &b&lBSSG Panel"
	// DefaultMax is het aantal plaatsen als server.properties er geen noemt.
	DefaultMax = 20
	// MaxIconBytes is de grootste server-icon.png die we gebruiken.
	MaxIconBytes = 64 * 1024
	accent       = "#a99bff" // kleur van het BSSG-logo
)

//go:embed server-icon.png
var logoPNG []byte

// LogoPNG geeft het ingebouwde BSSG-logo (64x64 PNG).
func LogoPNG() []byte { return append([]byte(nil), logoPNG...) }

// StyleOpts zijn de ingrediënten van een opgemaakt antwoord.
type StyleOpts struct {
	Name  string // servernaam (eerste regel)
	Promo string // `&`-codes; leeg = DefaultPromo
	Dir   string // servermap (server-icon.png, server.properties); leeg = niets lezen
	// LogoFallback: toon het BSSG-logo als de server geen eigen icoon heeft.
	LogoFallback bool
}

// Style is het vooraf opgebouwde antwoord.
type Style struct {
	Description json.RawMessage
	Kick        json.RawMessage
	Favicon     string
	Max         int
}

// NewStyle bouwt de opmaak; fouten bij het lezen van bestanden worden genegeerd (standaardwaarden).
func NewStyle(o StyleOpts) *Style {
	name := strings.TrimSpace(o.Name)
	if name == "" {
		name = "Server"
	}
	promo := strings.TrimSpace(o.Promo)
	if promo == "" {
		promo = DefaultPromo
	}
	st := &Style{Max: DefaultMax}
	extra := []any{
		comp("☾ ", accent, false),
		comp(name, accent, true),
		comp(" is sleeping\n", "gray", false),
	}
	extra = append(extra, ParseCodes(promo)...)
	st.Description, _ = json.Marshal(map[string]any{"text": "", "extra": extra})
	st.Kick, _ = json.Marshal(map[string]any{"text": "", "extra": []any{
		comp("⚡ ", "yellow", false),
		comp(name, accent, true),
		comp(" is starting", "white", false),
		comp(" — reconnect in about a minute", "gray", false),
	}})
	var icon []byte
	if o.Dir != "" {
		st.Max = readMaxPlayers(o.Dir)
		icon = ReadIcon(filepath.Join(o.Dir, "server-icon.png"))
	}
	if icon == nil && o.LogoFallback {
		icon = logoPNG
	}
	if icon != nil {
		st.Favicon = "data:image/png;base64," + base64.StdEncoding.EncodeToString(icon)
	}
	return st
}

func (s *Style) apply(st *Status) {
	st.Description = s.Description
	st.Favicon = s.Favicon
	st.Players.Max = s.Max
	st.Players.Sample = []Sample{{Name: "§7Join to start the server", ID: "00000000-0000-0000-0000-000000000000"}}
}

func comp(text, color string, bold bool) map[string]any {
	m := map[string]any{"text": text, "color": color}
	if bold {
		m["bold"] = true
	}
	return m
}

var legacyColors = map[byte]string{
	'0': "black", '1': "dark_blue", '2': "dark_green", '3': "dark_aqua", '4': "dark_red", '5': "dark_purple",
	'6': "gold", '7': "gray", '8': "dark_gray", '9': "blue", 'a': "green", 'b': "aqua", 'c': "red",
	'd': "light_purple", 'e': "yellow", 'f': "white",
}

// ParseCodes zet tekst met `&`-codes (`&a`, `&l`, `&r`, `&#rrggbb`) om in tekstcomponenten.
// Een kleurcode zet opmaak terug (zoals in Minecraft); `&&` is een letterlijke `&`.
func ParseCodes(s string) []any {
	var out []any
	color, bold := "white", false
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			out = append(out, comp(buf.String(), color, bold))
			buf.Reset()
		}
	}
	for i := 0; i < len(s); i++ {
		if s[i] != '&' || i+1 >= len(s) {
			buf.WriteByte(s[i])
			continue
		}
		n := s[i+1]
		switch {
		case n == '&':
			buf.WriteByte('&')
			i++
		case n == '#' && i+8 <= len(s) && isHex(s[i+2:i+8]):
			flush()
			color, bold = "#"+strings.ToLower(s[i+2:i+8]), false
			i += 7
		case n == 'l' || n == 'L':
			flush()
			bold = true
			i++
		case n == 'r' || n == 'R':
			flush()
			color, bold = "white", false
			i++
		default:
			if c, ok := legacyColors[lower(n)]; ok {
				flush()
				color, bold = c, false
				i++
			} else {
				buf.WriteByte('&')
			}
		}
	}
	flush()
	return out
}

func lower(b byte) byte {
	if b >= 'A' && b <= 'F' {
		return b + 32
	}
	return b
}

func isHex(s string) bool {
	if len(s) != 6 {
		return false
	}
	for i := 0; i < 6; i++ {
		c := lower(s[i])
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// ReadIcon leest een server-icon.png veilig: gewoon bestand (geen symlink), maximaal
// MaxIconBytes, geldige PNG van precies 64x64. Anders nil.
func ReadIcon(path string) []byte {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > MaxIconBytes || fi.Size() == 0 {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxIconBytes+1))
	if err != nil || len(b) > MaxIconBytes {
		return nil
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width != 64 || cfg.Height != 64 {
		return nil
	}
	return b
}

func readMaxPlayers(dir string) int {
	f, err := os.OpenFile(filepath.Join(dir, "server.properties"), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return DefaultMax
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, 64*1024))
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "max-players="); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 && n < 1_000_000 {
				return n
			}
		}
	}
	return DefaultMax
}
