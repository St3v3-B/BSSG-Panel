// Package spec bevat de ServerSpec uit openapi.yaml, validatie, het vervangen van
// {{VAR}} en het bijwerken van config-bestanden.
package spec

import (
	"errors"
	"fmt"
	"net"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Stop is het stop-commando of -signaal.
type Stop struct {
	Type  string `json:"type"`
	Value string `json:"value"`
	// TimeoutSeconds: zo lang wachten voordat de daemon killt (0 = standaard van de daemon, 30 s).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

// Limits uit openapi.yaml.
type Limits struct {
	CPUPct   int  `json:"cpu_pct"`
	MemoryMB int  `json:"memory_mb"`
	SwapMB   int  `json:"swap_mb"`
	DiskMB   int  `json:"disk_mb"`
	Pids     *int `json:"pids,omitempty"`
}

// PidsOrDefault geeft de PID-limiet (standaard 512).
func (l Limits) PidsOrDefault() int {
	if l.Pids == nil || *l.Pids == 0 {
		return 512
	}
	return *l.Pids
}

// Allocation is een IP + poort.
type Allocation struct {
	IP      string `json:"ip"`
	Port    int    `json:"port"`
	Primary bool   `json:"primary,omitempty"`
	// Protocol: tcp, udp of both (leeg = both, zoals vóór dit veld).
	Protocol string `json:"protocol,omitempty"`
}

// Protocols geeft de Docker-protocollen van de allocation ("tcp", "udp").
func (a Allocation) Protocols() []string {
	switch a.Protocol {
	case "tcp":
		return []string{"tcp"}
	case "udp":
		return []string{"udp"}
	default:
		return []string{"tcp", "udp"}
	}
}

// Install is het install-script.
type Install struct {
	Image  string `json:"image"`
	Script string `json:"script"`
	// TimeoutMinutes: maximale duur (0 = standaard van de daemon, 30 min).
	TimeoutMinutes int `json:"timeout_minutes,omitempty"`
}

// ConfigFile wordt vóór elke start bijgewerkt.
type ConfigFile struct {
	Path   string            `json:"path"`
	Format string            `json:"format"`
	Set    map[string]string `json:"set"`
}

// Sleep is de slaapstand (alleen game, Minecraft Java).
type Sleep struct {
	IdleMinutes int    `json:"idle_minutes"`
	MOTD        string `json:"motd,omitempty"`
	KickMessage string `json:"kick_message,omitempty"`
	// ServerName, Promo en FaviconMode sturen de opgemaakte MOTD (zonder ServerName: alleen MOTD).
	ServerName  string `json:"server_name,omitempty"`
	Promo       string `json:"promo,omitempty"`
	FaviconMode string `json:"favicon_mode,omitempty"` // server_or_logo (standaard) of server_only
}

// AutoRestart: automatisch herstarten na een crash, hooguit MaxPer10Min keer per 10 minuten.
type AutoRestart struct {
	MaxPer10Min int `json:"max_per_10min"`
}

// Standaardteksten van de slaapstand.
const (
	DefaultSleepMOTD = "Server is sleeping - join to start it"
	DefaultSleepKick = "The server is starting, please reconnect in a minute."
)

// Texts geeft motd en kick_message met standaardwaarden.
func (s *Sleep) Texts() (motd, kick string) {
	motd, kick = s.MOTD, s.KickMessage
	if motd == "" {
		motd = DefaultSleepMOTD
	}
	if kick == "" {
		kick = DefaultSleepKick
	}
	return motd, kick
}

// ImageUpdate is het beleid voor image-updates van een server (ServerSpec.image_update).
type ImageUpdate struct {
	// Policy: default (globale standaard van het panel), auto, notify of off.
	Policy string `json:"policy,omitempty"`
	// VersionEnv: env-variabele in de image-config waarvan major.minor gelijk moet blijven.
	VersionEnv *string `json:"version_env,omitempty"`
}

// ServerSpec is de volledige spec die het panel stuurt.
type ServerSpec struct {
	UUID           string            `json:"uuid"`
	Type           string            `json:"type"`
	Image          string            `json:"image"`
	Startup        string            `json:"startup"`
	Stop           Stop              `json:"stop"`
	ReadyPattern   string            `json:"ready_pattern"`
	Environment    map[string]string `json:"environment"`
	Limits         Limits            `json:"limits"`
	Allocations    []Allocation      `json:"allocations"`
	HTTPPort       *int              `json:"http_port,omitempty"`
	Install        Install           `json:"install"`
	ConfigFiles    []ConfigFile      `json:"config_files,omitempty"`
	StartOnInstall bool              `json:"start_on_install,omitempty"`
	SkipInstall    bool              `json:"skip_install,omitempty"`
	// ServerIcon "bssg": na de installatie het logo als server-icon.png zetten als er geen is.
	ServerIcon  string       `json:"server_icon,omitempty"`
	Sleep       *Sleep       `json:"sleep,omitempty"`
	ImageUpdate *ImageUpdate `json:"image_update,omitempty"`
	AutoRestart *AutoRestart `json:"auto_restart,omitempty"`
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ValidUUID controleert het uuid-formaat.
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var signals = map[string]bool{"SIGTERM": true, "SIGINT": true, "SIGKILL": true, "SIGQUIT": true}

// Validate controleert de spec; de fout is geschikt voor een 400-antwoord.
func (s *ServerSpec) Validate() error {
	var errs []string
	if s.ServerIcon != "" && s.ServerIcon != "none" && s.ServerIcon != "bssg" {
		errs = append(errs, "server_icon invalid")
	}
	add := func(f string, a ...any) { errs = append(errs, fmt.Sprintf(f, a...)) }
	if !ValidUUID(s.UUID) {
		add("uuid invalid")
	}
	if s.Type != "game" && s.Type != "web" {
		add("type must be game or web")
	}
	if strings.TrimSpace(s.Image) == "" {
		add("image missing")
	}
	if strings.TrimSpace(s.Startup) == "" {
		add("startup missing")
	}
	switch s.Stop.Type {
	case "command":
		if s.Stop.Value == "" {
			add("stop.value missing")
		}
	case "signal":
		if !signals[s.Stop.Value] {
			add("stop.value must be SIGTERM, SIGINT, SIGKILL or SIGQUIT")
		}
	default:
		add("stop.type must be command or signal")
	}
	if t := s.Stop.TimeoutSeconds; t != 0 && (t < 5 || t > 600) {
		add("stop.timeout_seconds must be between 5 and 600")
	}
	if t := s.Install.TimeoutMinutes; t < 0 || t > 720 {
		add("install.timeout_minutes must be between 0 and 720")
	}
	if _, err := regexp.Compile(s.ReadyPattern); err != nil {
		add("ready_pattern: %v", err)
	}
	for k := range s.Environment {
		if !envKeyRe.MatchString(k) {
			add("environment: invalid key %q", k)
		}
	}
	l := s.Limits
	if l.CPUPct < 0 {
		add("limits.cpu_pct < 0")
	}
	if l.MemoryMB < 64 {
		add("limits.memory_mb < 64")
	}
	if l.SwapMB < -1 {
		add("limits.swap_mb < -1")
	}
	if l.DiskMB < 0 {
		add("limits.disk_mb < 0")
	}
	if l.Pids != nil && *l.Pids != 0 && *l.Pids < 32 {
		add("limits.pids < 32")
	}
	for i, a := range s.Allocations {
		if ip := net.ParseIP(a.IP); ip == nil || ip.To4() == nil {
			add("allocations[%d].ip invalid", i)
		}
		if a.Port < 1 || a.Port > 65535 {
			add("allocations[%d].port invalid", i)
		}
		if a.Protocol != "" && a.Protocol != "tcp" && a.Protocol != "udp" && a.Protocol != "both" {
			add("allocations[%d].protocol must be tcp, udp or both", i)
		}
	}
	seen := map[string]bool{}
	for i, a := range s.Allocations {
		k := a.IP + ":" + strconv.Itoa(a.Port)
		if seen[k] {
			add("allocations[%d]: %s dubbel", i, k)
		}
		seen[k] = true
	}
	if s.Sleep != nil {
		if s.Type != "game" {
			add("sleep alleen voor game")
		}
		if s.Sleep.IdleMinutes < 1 || s.Sleep.IdleMinutes > 1440 {
			add("sleep.idle_minutes must be between 1 and 1440")
		}
		if len(s.Allocations) == 0 {
			add("sleep requires an allocation")
		}
		if len(s.Sleep.MOTD) > 256 || len(s.Sleep.KickMessage) > 256 {
			add("sleep: motd/kick_message te lang")
		}
		if len(s.Sleep.ServerName) > 400 || len(s.Sleep.Promo) > 480 {
			add("sleep: server_name/promo too long")
		}
		if m := s.Sleep.FaviconMode; m != "" && m != "server_or_logo" && m != "server_only" {
			add("sleep.favicon_mode invalid")
		}
	}
	if s.AutoRestart != nil && (s.AutoRestart.MaxPer10Min < 1 || s.AutoRestart.MaxPer10Min > 20) {
		add("auto_restart.max_per_10min must be between 1 and 20")
	}
	if s.Type == "web" && len(s.Allocations) > 0 {
		add("web has no allocations")
	}
	if s.HTTPPort != nil && (*s.HTTPPort < 1 || *s.HTTPPort > 65535) {
		add("http_port invalid")
	}
	if strings.TrimSpace(s.Install.Image) == "" {
		add("install.image missing")
	}
	if strings.TrimSpace(s.Install.Script) == "" {
		add("install.script missing")
	}
	for i, f := range s.ConfigFiles {
		if f.Format != "properties" && f.Format != "yaml" && f.Format != "json" && f.Format != "toml" {
			add("config_files[%d].format invalid", i)
		}
		if _, err := CleanRel(f.Path); err != nil {
			add("config_files[%d].path: %v", i, err)
		}
	}
	if iu := s.ImageUpdate; iu != nil {
		switch iu.Policy {
		case "", "default", "auto", "notify", "off":
		default:
			add("image_update.policy invalid")
		}
		if iu.VersionEnv != nil && !envKeyRe.MatchString(*iu.VersionEnv) {
			add("image_update.version_env invalid")
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// SameAs vergelijkt twee specs, zonder de eenmalige vlaggen start_on_install/skip_install.
func (s ServerSpec) SameAs(o ServerSpec) bool {
	s.StartOnInstall, o.StartOnInstall = false, false
	s.SkipInstall, o.SkipInstall = false, false
	norm := func(x *ServerSpec) {
		if x.Environment == nil {
			x.Environment = map[string]string{}
		}
		if len(x.Allocations) == 0 {
			x.Allocations = nil
		} else {
			// "both" en leeg betekenen hetzelfde (oude specs hebben geen protocol).
			al := make([]Allocation, len(x.Allocations))
			copy(al, x.Allocations)
			for i := range al {
				if al[i].Protocol == "both" {
					al[i].Protocol = ""
				}
			}
			x.Allocations = al
		}
		if len(x.ConfigFiles) == 0 {
			x.ConfigFiles = nil
		}
		if x.Limits.Pids != nil && *x.Limits.Pids == 0 {
			x.Limits.Pids = nil
		}
	}
	norm(&s)
	norm(&o)
	return reflect.DeepEqual(s, o)
}

// Primary geeft de primaire allocation (eerste met primary, anders de eerste).
func (s *ServerSpec) Primary() (Allocation, bool) {
	for _, a := range s.Allocations {
		if a.Primary {
			return a, true
		}
	}
	if len(s.Allocations) > 0 {
		return s.Allocations[0], true
	}
	return Allocation{}, false
}

// Timezone voor containers.
const Timezone = "Europe/Amsterdam"

// Vars geeft environment plus de ingebouwde variabelen (die gaan voor).
func (s *ServerSpec) Vars() map[string]string {
	v := make(map[string]string, len(s.Environment)+5)
	for k, val := range s.Environment {
		v[k] = val
	}
	v["SERVER_UUID"] = s.UUID
	v["SERVER_MEMORY"] = strconv.Itoa(s.Limits.MemoryMB)
	v["TZ"] = Timezone
	if a, ok := s.Primary(); ok {
		v["SERVER_IP"] = a.IP
		v["SERVER_PORT"] = strconv.Itoa(a.Port)
	} else {
		v["SERVER_IP"] = "0.0.0.0"
		v["SERVER_PORT"] = ""
	}
	return v
}

var varRe = regexp.MustCompile(`\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}`)

// Expand vervangt {{VAR}}; onbekende variabelen blijven staan.
func Expand(s string, vars map[string]string) string {
	return varRe.ReplaceAllStringFunc(s, func(m string) string {
		k := varRe.FindStringSubmatch(m)[1]
		if v, ok := vars[k]; ok {
			return v
		}
		return m
	})
}

// EnvList zet vars om naar KEY=value, gesorteerd zodat de uitkomst stabiel is.
func EnvList(vars map[string]string) []string {
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+vars[k])
	}
	return out
}
