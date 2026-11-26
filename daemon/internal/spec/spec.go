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
}

// Install is het install-script.
type Install struct {
	Image  string `json:"image"`
	Script string `json:"script"`
}

// ConfigFile wordt vóór elke start bijgewerkt.
type ConfigFile struct {
	Path   string            `json:"path"`
	Format string            `json:"format"`
	Set    map[string]string `json:"set"`
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
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ValidUUID controleert het uuid-formaat.
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

var envKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var signals = map[string]bool{"SIGTERM": true, "SIGINT": true, "SIGKILL": true, "SIGQUIT": true}

// Validate controleert de spec; de fout is geschikt voor een 400-antwoord.
func (s *ServerSpec) Validate() error {
	var errs []string
	add := func(f string, a ...any) { errs = append(errs, fmt.Sprintf(f, a...)) }
	if !ValidUUID(s.UUID) {
		add("uuid ongeldig")
	}
	if s.Type != "game" && s.Type != "web" {
		add("type moet game of web zijn")
	}
	if strings.TrimSpace(s.Image) == "" {
		add("image ontbreekt")
	}
	if strings.TrimSpace(s.Startup) == "" {
		add("startup ontbreekt")
	}
	switch s.Stop.Type {
	case "command":
		if s.Stop.Value == "" {
			add("stop.value ontbreekt")
		}
	case "signal":
		if !signals[s.Stop.Value] {
			add("stop.value moet SIGTERM, SIGINT, SIGKILL of SIGQUIT zijn")
		}
	default:
		add("stop.type moet command of signal zijn")
	}
	if _, err := regexp.Compile(s.ReadyPattern); err != nil {
		add("ready_pattern: %v", err)
	}
	for k := range s.Environment {
		if !envKeyRe.MatchString(k) {
			add("environment: ongeldige sleutel %q", k)
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
			add("allocations[%d].ip ongeldig", i)
		}
		if a.Port < 1 || a.Port > 65535 {
			add("allocations[%d].port ongeldig", i)
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
	if s.Type == "web" && len(s.Allocations) > 0 {
		add("web heeft geen allocations")
	}
	if s.HTTPPort != nil && (*s.HTTPPort < 1 || *s.HTTPPort > 65535) {
		add("http_port ongeldig")
	}
	if strings.TrimSpace(s.Install.Image) == "" {
		add("install.image ontbreekt")
	}
	if strings.TrimSpace(s.Install.Script) == "" {
		add("install.script ontbreekt")
	}
	for i, f := range s.ConfigFiles {
		if f.Format != "properties" && f.Format != "yaml" && f.Format != "json" {
			add("config_files[%d].format ongeldig", i)
		}
		if _, err := CleanRel(f.Path); err != nil {
			add("config_files[%d].path: %v", i, err)
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
