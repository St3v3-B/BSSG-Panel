// Package mail beheert de mailstack van de lokale node (Compose-profiel `mail`: Postfix, Dovecot, Rspamd, ClamAV,
// Unbound, eigen Redis) en voert de systeemcheck uit.
//
// De daemon spreekt uitsluitend containers aan met panel.managed=true, panel.instance=<PANEL_INSTANCE> én
// panel.role=mail, en doet daar alleen `docker exec` (doveadm, postqueue, postsuper, postconf, postfix reload,
// rspamadm, en bestanden in de DKIM-map), een SIGHUP aan Rspamd als `rspamadm control reload` niet lukt, en
// `docker compose --profile mail up -d|stop` voor precies de diensten van dat profiel. Alle exec-argumenten gaan
// als argv; gebruikersinvoer wordt vooraf strikt gevalideerd en komt nooit in een shell.
package mail

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"

	"panel/daemon/internal/engine"
)

var (
	// ErrNotConfigured: MAIL_HOSTNAME is leeg (409 mail_not_configured).
	ErrNotConfigured = errors.New("mail is not configured on this node (MAIL_HOSTNAME is empty)")
	// ErrNotRunning: de benodigde mailcontainer draait niet (409 mail_not_running).
	ErrNotRunning = errors.New("mail container is not running")
	// ErrInvalid: ongeldige invoer (400).
	ErrInvalid = errors.New("invalid input")
	// ErrNotFound: wachtrij-item bestaat niet (404).
	ErrNotFound = errors.New("not found")
	// ErrNoCompose: geen panel-checkout (PANEL_REPO_DIR) om compose mee te draaien (404 not_local).
	ErrNoCompose = errors.New("this node has no panel checkout (PANEL_REPO_DIR); mail stack cannot be managed")
)

// Docker is wat het mailpakket van Docker gebruikt (engine.Docker voldoet via NewDockerAdapter; tests faken het).
type Docker interface {
	// Containers geeft containers met al deze labels (nil = alle).
	Containers(ctx context.Context, labels map[string]string) ([]engine.ContainerSummary, error)
	Exec(ctx context.Context, id string, o engine.ExecIO) (engine.ExecIOResult, error)
	Signal(ctx context.Context, id, signal string) error
	// IPs geeft netwerk → IPv4 van een container.
	IPs(ctx context.Context, id string) (map[string]string, error)
}

type dockerAdapter struct{ d *engine.Docker }

// NewDockerAdapter maakt een Docker van de echte engine.
func NewDockerAdapter(d *engine.Docker) Docker { return dockerAdapter{d} }

func (a dockerAdapter) Containers(ctx context.Context, labels map[string]string) ([]engine.ContainerSummary, error) {
	return a.d.ContainerSummaries(ctx, labels)
}
func (a dockerAdapter) Exec(ctx context.Context, id string, o engine.ExecIO) (engine.ExecIOResult, error) {
	return a.d.ExecStream(ctx, id, o)
}
func (a dockerAdapter) Signal(ctx context.Context, id, sig string) error {
	return a.d.Kill(ctx, id, sig)
}
func (a dockerAdapter) IPs(ctx context.Context, id string) (map[string]string, error) {
	c, err := a.d.Inspect(ctx, id)
	return c.Networks, err
}

// Config zijn de instellingen (zie config.MailFromEnv voor de env-namen en standaarden).
type Config struct {
	// Hostname (MAIL_HOSTNAME): leeg = mailmodule uit. Als EnvFile leesbaar is en daar MAIL_HOSTNAME in staat,
	// gaat die waarde voor (zo werkt een wijziging in panel.env zonder herstart van de daemon).
	Hostname   string
	PublicIPv4 string // MAIL_PUBLIC_IPV4
	PublicIPv6 string // MAIL_PUBLIC_IPV6
	Instance   string // PANEL_INSTANCE

	// Compose: RepoDir/deploy/docker-compose.yml met --env-file EnvFile (zelfde aanroep als install.sh).
	RepoDir        string
	EnvFile        string
	HTTPMode       string // "npm" voegt docker-compose.npm.yml toe
	ComposeProfile string // standaard "mail"

	Postfix string // MAIL_POSTFIX_CONTAINER
	Dovecot string // MAIL_DOVECOT_CONTAINER
	Rspamd  string // MAIL_RSPAMD_CONTAINER
	Unbound string // MAIL_UNBOUND_CONTAINER

	DKIMDir   string // MAIL_DKIM_DIR (in panel-rspamd)
	DKIMOwner string // MAIL_DKIM_OWNER ("" = eigenaar van DKIMDir overnemen)
	VmailDir  string // MAIL_VMAIL_DIR (in panel-dovecot)

	// Systeemcheck.
	CaddyTLSAddr  string // CADDY_TLS_ADDR
	DNSBLResolver string // MAIL_DNSBL_RESOLVER: "" = panel-unbound (anders systeem), "system", of host:poort
	NTPServer     string // MAIL_NTP_SERVER
	DiskPath      string // MAIL_DISK_PATH: map op de host voor de schijfcheck
}

func (c *Config) defaults() {
	def := func(p *string, v string) {
		if *p == "" {
			*p = v
		}
	}
	def(&c.Instance, "main")
	def(&c.EnvFile, "/etc/panel/panel.env")
	def(&c.ComposeProfile, "mail")
	def(&c.Postfix, "panel-postfix")
	def(&c.Dovecot, "panel-dovecot")
	def(&c.Rspamd, "panel-rspamd")
	def(&c.Unbound, "panel-unbound")
	def(&c.DKIMDir, "/var/lib/rspamd/dkim")
	def(&c.VmailDir, "/var/vmail")
	def(&c.CaddyTLSAddr, "127.0.0.1:443")
	def(&c.NTPServer, "pool.ntp.org")
	def(&c.DiskPath, "/var/lib/docker")
}

// Service is de mailbeheerder van de lokale node.
type Service struct {
	cfg  Config
	dock Docker
	log  *slog.Logger
	// Compose draait `docker compose` (tests vervangen dit).
	Compose ComposeRunner
	// Checks: injecteerbare afhankelijkheden van de systeemcheck (nil-velden krijgen de echte implementatie).
	Checks CheckEnv

	dkimMu sync.Mutex
	opMu   sync.Mutex // enable/disable niet tegelijk
}

// New maakt de service.
func New(cfg Config, d Docker, log *slog.Logger) *Service {
	cfg.defaults()
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Service{cfg: cfg, dock: d, log: log}
}

// Hostname geeft MAIL_HOSTNAME (eerst uit het env-bestand, anders uit de omgeving van de daemon), lowercase.
func (s *Service) Hostname() string {
	if v, ok := readEnvFile(s.cfg.EnvFile, "MAIL_HOSTNAME"); ok {
		return normHost(v)
	}
	return normHost(s.cfg.Hostname)
}

func (s *Service) envOr(key, def string) string {
	if v, ok := readEnvFile(s.cfg.EnvFile, key); ok {
		return v
	}
	return def
}

// readEnvFile leest KEY=waarde uit een env-bestand (laatste wint); ok=false als het bestand of de sleutel ontbreekt.
func readEnvFile(path, key string) (string, bool) {
	if path == "" {
		return "", false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	val, found := "", false
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != key {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		val, found = v, true
	}
	return val, found
}

func normHost(h string) string { return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".") }

// labels zijn de verplichte labels van elke mailcontainer.
func (s *Service) labels() map[string]string {
	return map[string]string{"panel.managed": "true", "panel.instance": s.cfg.Instance, "panel.role": "mail"}
}

// containers geeft alle mailcontainers (met de drie labels; dubbel gecontroleerd).
func (s *Service) containers(ctx context.Context) ([]engine.ContainerSummary, error) {
	list, err := s.dock.Containers(ctx, s.labels())
	if err != nil {
		return nil, err
	}
	out := list[:0]
	for _, c := range list {
		if s.isMail(c.Labels) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (s *Service) isMail(l map[string]string) bool {
	return l["panel.managed"] == "true" && l["panel.instance"] == s.cfg.Instance && l["panel.role"] == "mail"
}

// container zoekt een draaiende mailcontainer op naam; ErrNotRunning als hij er niet is of niet draait.
func (s *Service) container(ctx context.Context, name string) (engine.ContainerSummary, error) {
	list, err := s.containers(ctx)
	if err != nil {
		return engine.ContainerSummary{}, err
	}
	for _, c := range list {
		if c.Name == name {
			if c.State != "running" {
				return c, fmt.Errorf("%w: %s is %s", ErrNotRunning, name, c.State)
			}
			return c, nil
		}
	}
	return engine.ContainerSummary{}, fmt.Errorf("%w: %s does not exist", ErrNotRunning, name)
}

// ExecError is een commando dat met een andere exitcode dan 0 eindigde.
type ExecError struct {
	Cmd    string
	Code   int
	Stderr string
}

func (e *ExecError) Error() string {
	return fmt.Sprintf("%s exited with %d: %s", e.Cmd, e.Code, trim(e.Stderr))
}

func trim(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 400 {
		s = s[len(s)-400:]
	}
	return s
}

// limitWriter bewaart hoogstens max bytes.
type limitWriter struct {
	buf bytes.Buffer
	max int
}

func (w *limitWriter) Write(p []byte) (int, error) {
	if room := w.max - w.buf.Len(); room > 0 {
		if len(p) > room {
			w.buf.Write(p[:room])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}

// exec voert argv uit in de (draaiende) mailcontainer name, als root, en geeft stdout (max 8 MiB).
func (s *Service) exec(ctx context.Context, name string, stdin io.Reader, argv ...string) (string, error) {
	out, _, err := s.execOut(ctx, name, stdin, argv...)
	return out, err
}

// execOut is exec dat ook stderr teruggeeft.
func (s *Service) execOut(ctx context.Context, name string, stdin io.Reader, argv ...string) (string, string, error) {
	c, err := s.container(ctx, name)
	if err != nil {
		return "", "", err
	}
	out := &limitWriter{max: 8 << 20}
	r, err := s.dock.Exec(ctx, c.ID, engine.ExecIO{Cmd: argv, User: "0", Stdin: stdin, Stdout: out})
	if err != nil {
		if errors.Is(err, engine.ErrNotFound) {
			return "", "", fmt.Errorf("%w: %s", ErrNotRunning, name)
		}
		return "", "", err
	}
	if r.ExitCode != 0 {
		return out.buf.String(), r.Stderr, &ExecError{Cmd: argv[0], Code: r.ExitCode, Stderr: r.Stderr + "\n" + out.buf.String()}
	}
	return out.buf.String(), r.Stderr, nil
}

// running zegt of de mailcontainer name draait.
func (s *Service) running(ctx context.Context, name string) bool {
	_, err := s.container(ctx, name)
	return err == nil
}
