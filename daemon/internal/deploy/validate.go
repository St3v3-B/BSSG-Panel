package deploy

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"panel/daemon/internal/files"
)

// Remote is een gevalideerde repository-URL.
type Remote struct {
	// Scheme is https, http (alleen met AllowHTTP, voor tests) of ssh.
	Scheme string
	Host   string
	Port   int
	// URL is wat git krijgt (scp-vorm blijft scp-vorm).
	URL string
}

var (
	hostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	userRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	// scp-vorm: user@host:pad (pad zonder spatie, niet met '-' of '/' na de dubbele punt... '/' mag).
	scpRe = regexp.MustCompile(`^([A-Za-z0-9._-]{1,64})@([A-Za-z0-9.-]{1,253}):([A-Za-z0-9._~/][A-Za-z0-9._~/+-]{0,400})$`)
	// pad in een URL: geen spaties, geen procent-escapes van control chars (gecontroleerd na decoderen).
	urlPathRe = regexp.MustCompile(`^/[A-Za-z0-9._~/+@-]{1,400}$`)
	imageRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9._/:@-]{0,199}$`)
	branchRe  = regexp.MustCompile(`^[A-Za-z0-9._/+-]{1,200}$`)
)

// ParseRemote controleert een repository-URL. Toegestaan: https://host[:port]/pad,
// ssh://[user@]host[:port]/pad en user@host:pad. Geen inloggegevens in https-URL's, geen
// file://, ext::, lokale paden, opties ("-…") of control characters.
func ParseRemote(raw string, allowHTTP bool) (Remote, error) {
	bad := func(why string) (Remote, error) { return Remote{}, fmt.Errorf("invalid repository URL: %s", why) }
	if raw == "" || len(raw) > 500 {
		return bad("empty or too long")
	}
	for _, c := range raw {
		if c <= 0x20 || c == 0x7f || c == '\\' || c == '"' || c == '\'' || c == '`' || c == '$' || c == ';' || c == '|' || c == '&' {
			return bad("contains forbidden characters")
		}
	}
	if strings.HasPrefix(raw, "-") || strings.Contains(raw, "::") {
		return bad("transport helpers and options are not allowed")
	}
	if m := scpRe.FindStringSubmatch(raw); m != nil && !strings.Contains(raw, "://") {
		host := m[2]
		if !hostRe.MatchString(host) || strings.HasPrefix(m[3], "-") || strings.Contains(m[3], "..") {
			return bad("bad host or path")
		}
		return Remote{Scheme: "ssh", Host: strings.ToLower(host), Port: 22, URL: raw}, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return bad("cannot parse")
	}
	switch u.Scheme {
	case "https", "ssh":
	case "http":
		if !allowHTTP {
			return bad("only https:// and SSH are allowed")
		}
	default:
		return bad("only https:// and SSH are allowed")
	}
	if u.Opaque != "" || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return bad("no query or fragment")
	}
	host := u.Hostname()
	if host == "" || strings.HasPrefix(host, "-") || !(hostRe.MatchString(host) || net.ParseIP(host) != nil) {
		return bad("bad host")
	}
	if u.User != nil {
		if u.Scheme != "ssh" {
			return bad("put the token in the token field, not in the URL")
		}
		if _, hasPw := u.User.Password(); hasPw || !userRe.MatchString(u.User.Username()) {
			return bad("bad SSH user")
		}
	}
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if u.Scheme == "ssh" {
		port = 22
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return bad("bad port")
		}
		port = n
	}
	if !urlPathRe.MatchString(u.Path) || strings.Contains(u.Path, "..") || u.RawPath != "" && u.RawPath != u.EscapedPath() {
		return bad("bad path")
	}
	return Remote{Scheme: u.Scheme, Host: strings.ToLower(host), Port: port, URL: raw}, nil
}

// ValidBranch volgt de regels van git check-ref-format voor een branchnaam (strenger).
func ValidBranch(b string) error {
	switch {
	case !branchRe.MatchString(b),
		strings.HasPrefix(b, "-"), strings.HasPrefix(b, "/"), strings.HasSuffix(b, "/"),
		strings.HasSuffix(b, "."), strings.HasSuffix(b, ".lock"),
		strings.Contains(b, ".."), strings.Contains(b, "//"), strings.Contains(b, "/."),
		strings.HasPrefix(b, "."), b == "HEAD":
		return errors.New("invalid branch name")
	}
	return nil
}

// stageDir is de werkmap van de deploy binnen de serverdata (nooit een doelmap).
const stageDir = ".panel-deploy"

// cleanRel zet een API-pad om naar een relatief pad (files.Clean); "." is de root.
func cleanRel(p string) (string, error) {
	if strings.ContainsAny(p, "\x00\n\r") {
		return "", files.ErrBadPath
	}
	return files.Clean(p)
}

// Validate controleert een DeployRequest en vult standaardwaarden in.
func (r *Request) Validate(allowHTTP bool) (Remote, error) {
	if r.DeployID < 1 {
		return Remote{}, errors.New("deploy_id is required")
	}
	rem, err := ParseRemote(r.RepoURL, allowHTTP)
	if err != nil {
		return Remote{}, err
	}
	if err := ValidBranch(r.Branch); err != nil {
		return Remote{}, err
	}
	switch r.Auth.Type {
	case "", "none":
		r.Auth.Type = "none"
	case "token":
		if rem.Scheme == "ssh" {
			return Remote{}, errors.New("token authentication needs an https URL")
		}
		if r.Auth.Token == "" || strings.ContainsAny(r.Auth.Token, "\x00\n\r") || strings.ContainsAny(r.Auth.Username, "\x00\n\r:") {
			return Remote{}, errors.New("invalid token")
		}
		if r.Auth.Username == "" {
			r.Auth.Username = "x-access-token"
		}
	case "ssh":
		if rem.Scheme != "ssh" {
			return Remote{}, errors.New("SSH authentication needs an SSH URL")
		}
		if !strings.Contains(r.Auth.PrivateKey, "PRIVATE KEY") || strings.TrimSpace(r.Auth.KnownHosts) == "" {
			return Remote{}, errors.New("ssh needs private_key and known_hosts")
		}
	default:
		return Remote{}, errors.New("invalid auth type")
	}
	if rem.Scheme == "ssh" && r.Auth.Type != "ssh" {
		return Remote{}, errors.New("SSH URLs need SSH authentication")
	}
	t, err := cleanRel(r.TargetDir)
	if err != nil || t == "." {
		return Remote{}, errors.New("target_dir must be a folder inside the site, not the root")
	}
	if t == stageDir || strings.HasPrefix(t, stageDir+"/") {
		return Remote{}, errors.New("target_dir cannot be the deploy work folder")
	}
	r.TargetDir = t
	src, err := cleanRel(r.SourceDir)
	if err != nil {
		return Remote{}, errors.New("invalid source_dir")
	}
	r.SourceDir = src
	if len(r.SharedPaths) > 50 {
		return Remote{}, errors.New("too many shared paths")
	}
	seen := map[string]bool{}
	var shared []string
	for _, p := range r.SharedPaths {
		c, err := cleanRel(p)
		if err != nil || c == "." {
			return Remote{}, fmt.Errorf("invalid shared path %q", p)
		}
		if !seen[c] {
			seen[c] = true
			shared = append(shared, c)
		}
	}
	// Een gedeeld pad binnen een ander gedeeld pad is overbodig (en zou dubbel verplaatsen).
	for _, a := range shared {
		for _, b := range shared {
			if a != b && strings.HasPrefix(b, a+"/") {
				return Remote{}, fmt.Errorf("shared path %q is inside %q", b, a)
			}
		}
	}
	r.SharedPaths = shared
	if r.Build != nil {
		r.Build.Command = strings.TrimSpace(r.Build.Command)
		if r.Build.Command == "" {
			r.Build = nil
		} else if len(r.Build.Command) > 2000 || strings.ContainsRune(r.Build.Command, 0) || !imageRe.MatchString(r.Build.Image) {
			return Remote{}, errors.New("invalid build command or image")
		}
	}
	if r.TimeoutSeconds == 0 {
		r.TimeoutSeconds = 1800
	}
	if r.TimeoutSeconds < 30 || r.TimeoutSeconds > 7200 {
		return Remote{}, errors.New("timeout_seconds out of range")
	}
	if r.LogLines == 0 {
		r.LogLines = 300
	}
	if r.LogLines < 10 || r.LogLines > 2000 {
		return Remote{}, errors.New("log_lines out of range")
	}
	return rem, nil
}
