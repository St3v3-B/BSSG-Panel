package proxy

// Draait de webtemplates uit templates/web/ zoals de daemon dat doet (install als
// root met netwerk, chown naar 1000, dan de runtime-container als uid 1000 met
// read-only rootfs, tmpfs /tmp, cap-drop ALL, no-new-privileges, op een eigen
// intern site-netwerk) en haalt de site op via Caddy met een route met
// Upstream.Network. Zelfde labels en overslaan-regels als caddy_docker_test.go.

import (
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"

	"panel/daemon/internal/spec"
)

type webTemplate struct {
	Slug         string `yaml:"slug"`
	Type         string `yaml:"type"`
	Image        string `yaml:"image"`
	Startup      string `yaml:"startup"`
	ReadyPattern string `yaml:"ready_pattern"`
	HTTPPort     int    `yaml:"http_port"`
	Stop         struct {
		Type  string `yaml:"type"`
		Value string `yaml:"value"`
	} `yaml:"stop"`
	Variables []struct {
		Key     string `yaml:"key"`
		Default string `yaml:"default"`
	} `yaml:"variables"`
	Install struct {
		Image  string `yaml:"image"`
		Script string `yaml:"script"`
	} `yaml:"install"`
}

func loadWebTemplate(t *testing.T, slug string) webTemplate {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("../../templates/web", slug+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var w webTemplate
	if err := yaml.Unmarshal(b, &w); err != nil {
		t.Fatal(err)
	}
	if w.Slug != slug || w.Type != "web" || w.HTTPPort <= 1024 {
		t.Fatalf("%s: slug/type/http_port klopt niet: %+v", slug, w)
	}
	return w
}

// site is één draaiende webtemplate.
type site struct {
	name, network, vol string
}

// runSite installeert en start een template; files worden na de installatie in
// /home/container gezet (bv. een testpagina).
func (e *caddyEnv) runSite(t *testing.T, w webTemplate, files map[string]string) site {
	t.Helper()
	labels := []string{"--label", "panel.test=true", "--label", "panel.instance=" + e.inst, "--label", "panel.managed=true"}
	s := site{name: e.inst + "-" + w.Slug, network: e.inst + "-site-" + w.Slug, vol: t.TempDir()}
	if err := os.Chmod(s.vol, 0o755); err != nil {
		t.Fatal(err)
	}
	vars := map[string]string{"SERVER_UUID": "00000000-0000-0000-0000-" + w.Slug, "SERVER_MEMORY": "256",
		"SERVER_IP": "0.0.0.0", "SERVER_PORT": "0", "TZ": "Europe/Amsterdam"}
	for _, v := range w.Variables {
		vars[v.Key] = v.Default
	}
	env := []string{"-e", "HOME=/home/container"}
	for k, v := range vars {
		env = append(env, "-e", k+"="+v)
	}
	mount := []string{"-v", s.vol + ":/home/container", "-w", "/home/container"}

	// Install: als root, met netwerk (standaard bridge), zelfde mount.
	args := append(append(append(append([]string{"run", "--rm", "--name", s.name + "-install", "--user", "0:0",
		"--security-opt", "no-new-privileges", "--memory", "1g"}, labels...), env...), mount...),
		"--entrypoint", "/bin/sh", w.Install.Image, "-c", w.Install.Script)
	start := time.Now()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("install %s: %v\n%s", w.Slug, err, out)
	}
	t.Logf("install %s: %s", w.Slug, time.Since(start).Round(time.Second))
	for p, content := range files {
		full := filepath.Join(s.vol, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := filepath.WalkDir(s.vol, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, 1000, 1000)
	}); err != nil {
		t.Fatal(err)
	}

	// Eigen intern site-netwerk zoals de daemon het maakt (panel-site-<uuid>).
	dockerCmd(t, append(append([]string{"network", "create", "--internal", "--label", "panel.role=site"}, labels...), s.network)...)
	args = append(append(append(append([]string{"run", "-d", "-i", "--name", s.name, "--user", "1000:1000",
		"--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
		"--memory", "256m", "--network", s.network, "--label", "panel.role=server"}, labels...), env...), mount...),
		"--entrypoint", "/bin/sh", w.Image, "-c", spec.Expand(w.Startup, vars))
	dockerCmd(t, args...)

	re := regexp.MustCompile("(?m)" + w.ReadyPattern)
	deadline := time.Now().Add(60 * time.Second)
	for {
		logs, _ := exec.Command("docker", "logs", s.name).Output() // alleen stdout
		if re.Match(logs) {
			break
		}
		state := dockerCmd(t, "inspect", "-f", "{{.State.Status}}", s.name)
		if state != "running" || time.Now().After(deadline) {
			all, _ := exec.Command("docker", "logs", s.name).CombinedOutput()
			t.Fatalf("%s niet online (status %s):\n%s", w.Slug, state, all)
		}
		time.Sleep(300 * time.Millisecond)
	}
	return s
}

// stopSite stopt zoals de daemon (stop-signaal) en controleert dat de container
// netjes en binnen de tijd stopt.
func (e *caddyEnv) stopSite(t *testing.T, w webTemplate, s site) {
	t.Helper()
	if w.Stop.Type != "signal" {
		t.Fatalf("%s: stop-type %s niet getest", w.Slug, w.Stop.Type)
	}
	dockerCmd(t, "kill", "--signal", w.Stop.Value, s.name)
	deadline := time.Now().Add(20 * time.Second)
	for dockerCmd(t, "inspect", "-f", "{{.State.Status}}", s.name) == "running" {
		if time.Now().After(deadline) {
			t.Fatalf("%s stopt niet na %s", w.Slug, w.Stop.Value)
		}
		time.Sleep(200 * time.Millisecond)
	}
	if code := dockerCmd(t, "inspect", "-f", "{{.State.ExitCode}}", s.name); code != "0" {
		logs, _ := exec.Command("docker", "logs", s.name).CombinedOutput()
		t.Errorf("%s: exitcode %s na %s\n%s", w.Slug, code, w.Stop.Value, logs)
	}
}

// webTemplateCase: wat er na de installatie bij komt en wat we via Caddy controleren.
type webTemplateCase struct {
	slug  string
	files map[string]string
	check func(t *testing.T, e *caddyEnv, host string)
}

func bodyContains(want ...string) func(int, string, string) bool {
	return func(code int, _ string, b string) bool {
		if code != 200 {
			return false
		}
		for _, w := range want {
			if !strings.Contains(b, w) {
				return false
			}
		}
		return true
	}
}

func webTemplateCases() []webTemplateCase {
	return []webTemplateCase{
		{
			slug:  "static",
			files: map[string]string{"public/sub/index.html": "submap ok", "public/.env": "GEHEIM=1", "nginx/extra.conf": "location = /eigen { return 200 'eigen regel'; }"},
			check: func(t *testing.T, e *caddyEnv, host string) {
				e.get(t, "https://"+host+"/", bodyContains("Het werkt"))
				e.get(t, "https://"+host+"/sub/", bodyContains("submap ok"))
				e.get(t, "https://"+host+"/eigen", bodyContains("eigen regel"))
				e.get(t, "https://"+host+"/.env", func(code int, _, _ string) bool { return code == 403 })
				e.get(t, "https://"+host+"/bestaat-niet", func(code int, _, _ string) bool { return code == 404 })
				code, loc, _ := e.get(t, "https://"+host+"/sub", func(code int, _, _ string) bool { return code == 301 })
				if loc != "/sub/" {
					t.Errorf("redirect /sub = %d %q, want relatief /sub/", code, loc)
				}
			},
		},
	}
}

func TestDockerWebTemplates(t *testing.T) {
	e := setupCaddy(t)
	ctx := context.Background()
	c := e.router()
	only := os.Getenv("PANEL_WEB_TEMPLATES") // bv. "static,php-8.3"; leeg = alle
	for _, tc := range webTemplateCases() {
		if only != "" && !strings.Contains(","+only+",", ","+tc.slug+",") {
			continue
		}
		t.Run(tc.slug, func(t *testing.T) {
			w := loadWebTemplate(t, tc.slug)
			s := e.runSite(t, w, tc.files)
			host := tc.slug + ".site.test"
			if err := c.SetRoute(ctx, Route{Host: host, ServerUUID: w.Slug, Upstream: Upstream{Container: s.name, Network: s.network, Port: w.HTTPPort}}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(e.caddyNetworks(t), s.network) {
				t.Fatalf("Caddy niet gekoppeld aan %s", s.network)
			}
			tc.check(t, e, host)
			// Geen internet vanaf het interne site-netwerk.
			if out, err := exec.Command("docker", "exec", s.name, "/bin/sh", "-c", "wget -q -T 3 -O- http://1.1.1.1/ || exit 7").CombinedOutput(); err == nil {
				t.Errorf("site heeft internet op een intern netwerk: %s", out)
			}
			if err := c.RemoveRoute(ctx, host); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(e.caddyNetworks(t), s.network) {
				t.Errorf("Caddy na de laatste route nog aan %s", s.network)
			}
			e.stopSite(t, w, s)
		})
	}
}
