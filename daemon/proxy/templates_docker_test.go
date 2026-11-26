package proxy

// Draait de webtemplates uit templates/web/ zoals de daemon dat doet (install als
// root met netwerk, chown naar 1000, dan de runtime-container als uid 1000 met
// read-only rootfs, tmpfs /tmp, cap-drop ALL, no-new-privileges, op een eigen
// intern site-netwerk) en haalt de site op via Caddy met een route met
// Upstream.Network. Zelfde labels en overslaan-regels als caddy_docker_test.go.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/url"
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

func loadWebTemplate(t *testing.T, file string) webTemplate {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("../../templates/web", file+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var w webTemplate
	if err := yaml.Unmarshal(b, &w); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,48}$`).MatchString(w.Slug) || w.Type != "web" || w.HTTPPort <= 1024 {
		t.Fatalf("%s: slug/type/http_port klopt niet: %+v", file, w)
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
	// Heeft de image een HEALTHCHECK, dan moet de container healthy worden.
	if dockerCmd(t, "inspect", "-f", "{{if .State.Health}}ja{{end}}", s.name) == "ja" {
		deadline := time.Now().Add(90 * time.Second)
		for {
			h := dockerCmd(t, "inspect", "-f", "{{.State.Health.Status}}", s.name)
			if h == "healthy" {
				break
			}
			if h == "unhealthy" || time.Now().After(deadline) {
				log := dockerCmd(t, "inspect", "-f", "{{range .State.Health.Log}}{{.Output}}{{end}}", s.name)
				t.Fatalf("%s: healthcheck %s: %s", w.Slug, h, log)
			}
			time.Sleep(time.Second)
		}
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
	file  string // templates/web/<file>.yaml
	db    bool   // MariaDB als panel-mariadb op het site-netwerk
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
			file:  "static",
			files: map[string]string{"public/sub/index.html": "submap ok", "public/.env": "GEHEIM=1", "nginx/extra.conf": "location = /eigen { return 200 'eigen regel'; }"},
			check: func(t *testing.T, e *caddyEnv, host string) {
				e.get(t, "https://"+host+"/", bodyContains("<title>Your website is live 🎉</title>", "public/"))
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
		phpCase("php-8.2", "8.2."),
		phpCase("php-8.3", "8.3."),
		phpCase("php-8.4", "8.4."),
		{
			file: "node",
			check: func(t *testing.T, e *caddyEnv, host string) {
				e.get(t, "https://"+host+"/iets", bodyContains("<title>Your website is live 🎉</title>"))
			},
		},
		{
			file: "adminer",
			db:   true,
			check: func(t *testing.T, e *caddyEnv, host string) {
				e.get(t, "https://"+host+"/", bodyContains(`value="panel-mariadb"`))
				// Inloggen (sessie in /tmp) en de database wp openen.
				jar, _ := cookiejar.New(nil)
				hc := &http.Client{Timeout: 30 * time.Second, Jar: jar, Transport: e.client.Transport}
				if _, err := hc.Get("https://" + host + "/"); err != nil {
					t.Fatal(err)
				}
				var body string
				for i := 0; i < 30; i++ {
					resp, err := hc.PostForm("https://"+host+"/", url.Values{"auth[driver]": {"server"}, "auth[server]": {"panel-mariadb"},
						"auth[username]": {"wp"}, "auth[password]": {"wpgeheim"}, "auth[db]": {"wp"}})
					if err != nil {
						t.Fatal(err)
					}
					b, _ := io.ReadAll(resp.Body)
					resp.Body.Close()
					if body = string(b); strings.Contains(body, "Logout") {
						return
					}
					time.Sleep(time.Second) // MariaDB start nog
				}
				t.Fatalf("inloggen in Adminer mislukt: %.400s", body)
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
		if only != "" && !strings.Contains(","+only+",", ","+tc.file+",") {
			continue
		}
		t.Run(tc.file, func(t *testing.T) {
			w := loadWebTemplate(t, tc.file)
			if tc.db {
				e.startMariaDB(t)
			}
			s := e.runSite(t, w, tc.files)
			if tc.db {
				dockerCmd(t, "network", "connect", "--alias", "panel-mariadb", s.network, e.inst+"-mariadb")
			}
			host := w.Slug + ".site.test"
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
			if tc.db {
				dockerCmd(t, "network", "disconnect", s.network, e.inst+"-mariadb")
			}
		})
	}
}

// startMariaDB start (één keer per test) een MariaDB zoals panel-mariadb, met
// database/gebruiker wp/wp/wpgeheim. Hij hangt aan geen enkel netwerk tot een site
// hem koppelt (zoals de daemon panel-mariadb aan panel-site-<uuid> koppelt).
func (e *caddyEnv) startMariaDB(t *testing.T) {
	t.Helper()
	name := e.inst + "-mariadb"
	if exec.Command("docker", "inspect", name).Run() == nil {
		return
	}
	dockerCmd(t, "run", "-d", "--name", name, "--label", "panel.test=true", "--label", "panel.instance="+e.inst,
		"--network", "none", "--memory", "512m",
		"-e", "MARIADB_RANDOM_ROOT_PASSWORD=1", "-e", "MARIADB_DATABASE=wp", "-e", "MARIADB_USER=wp", "-e", "MARIADB_PASSWORD=wpgeheim",
		"mariadb:11")
	dockerCmd(t, "network", "disconnect", "none", name)
}

const phpTestPage = `<?php
header('Content-Type: text/plain');
foreach (['mysqli', 'pdo_mysql', 'gd', 'intl', 'zip', 'exif', 'curl', 'mbstring', 'Zend OPcache'] as $x)
  echo $x, '=', extension_loaded($x) ? 'ja' : 'nee', "\n";
echo 'upload=', ini_get('upload_max_filesize'), ' post=', ini_get('post_max_size'), "\n";
echo 'https=', $_SERVER['HTTPS'] ?? '', "\n";
echo 'version=', PHP_VERSION, "\n";
$m = null;
for ($i = 0; $i < 30 && !$m; $i++) { try { $m = new mysqli('panel-mariadb', 'wp', 'wpgeheim', 'wp', 3306); } catch (Throwable $e) { sleep(1); } }
$m->query('CREATE TABLE IF NOT EXISTS t (v VARCHAR(20))');
$m->query("INSERT INTO t VALUES ('mysqli-ok')");
echo 'db=', $m->query('SELECT v FROM t LIMIT 1')->fetch_row()[0], "\n";
$p = new PDO('mysql:host=panel-mariadb;dbname=wp', 'wp', 'wpgeheim');
echo 'pdo=', $p->query('SELECT 40+2')->fetchColumn(), "\n";
$im = imagecreatetruecolor(8, 8); ob_start(); imagewebp($im); imagepng($im); imagejpeg($im); $n = strlen(ob_get_clean());
echo 'gd=', $n > 0 ? 'ok' : 'nee', "\n";
echo 'intl=', (new NumberFormatter('nl_NL', NumberFormatter::DECIMAL))->format(1234.5), "\n";
session_start(); $_SESSION['x'] = 1; session_write_close();
echo 'session=', count(glob(session_save_path() . '/sess_*')) > 0 ? 'ok' : 'nee', "\n";
`

const phpUploadPage = `<?php
header('Content-Type: text/plain');
$f = $_FILES['f'] ?? null;
echo 'size=', $f ? $f['size'] : -1, ' err=', $f ? $f['error'] : -1, ' moved=', ($f && move_uploaded_file($f['tmp_name'], __DIR__ . '/uploads/x.bin')) ? 'ja' : 'nee';
`

func phpCase(file, version string) webTemplateCase {
	return webTemplateCase{
		file: file,
		db:   true,
		files: map[string]string{
			"public/index.php":     "<?php echo 'index.php PHP ', PHP_VERSION;",
			"public/healthcheck":   "eigen bestand",
			"public/info.php":      phpTestPage,
			"public/upload.php":    phpUploadPage,
			"public/uploads/x.php": "<?php echo 'mag niet';",
		},
		check: func(t *testing.T, e *caddyEnv, host string) {
			e.get(t, "https://"+host+"/info.php", bodyContains("version="+version, "mysqli=ja", "pdo_mysql=ja", "gd=ja", "intl=ja",
				"zip=ja", "exif=ja", "curl=ja", "mbstring=ja", "Zend OPcache=ja", "upload=64M post=64M", "https=on",
				"db=mysqli-ok", "pdo=42", "gd=ok", "intl=1.234,5", "session=ok"))
			// Permalinks gaan naar index.php.
			e.get(t, "https://"+host+"/2026/11/hallo-wereld/", bodyContains("index.php PHP "+version))
			// De standaardpagina van de installatie staat er, maar index.php gaat voor.
			e.get(t, "https://"+host+"/", bodyContains("index.php PHP "+version))
			e.get(t, "https://"+host+"/index.html", bodyContains("<title>Your website is live 🎉</title>"))
			e.get(t, "https://"+host+"/healthcheck", bodyContains("eigen bestand"))
			e.get(t, "https://"+host+"/uploads/x.php", func(code int, _, _ string) bool { return code == 403 })
			// Upload van 5 MB via Caddy (tijdelijke bestanden in de tmpfs).
			var buf bytes.Buffer
			mw := multipart.NewWriter(&buf)
			fw, _ := mw.CreateFormFile("f", "x.bin")
			_, _ = fw.Write(bytes.Repeat([]byte("a"), 5<<20))
			_ = mw.Close()
			resp, err := e.client.Post("https://"+host+"/upload.php", mw.FormDataContentType(), &buf)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if want := fmt.Sprintf("size=%d err=0 moved=ja", 5<<20); string(b) != want {
				t.Errorf("upload = %q, want %q", b, want)
			}
		},
	}
}
