package daemon

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
	"panel/daemon/internal/testpanel"
	"panel/daemon/proxy"
)

func (h *harness) raw(method, path string, body []byte) (int, []byte, http.Header) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.base+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+nodeToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b, res.Header
}

func newFilesServer(t *testing.T, diskMB int) (*harness, string) {
	h := newHarness(t, engine.NewFake(), nil, nil, "", nil, "")
	sp := testSpec(u1)
	sp["limits"] = map[string]any{"cpu_pct": 100, "memory_mb": 512, "swap_mb": 0, "disk_mb": diskMB}
	sp["config_files"] = []any{}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "offline", 5*time.Second)
	vol := filepath.Join(h.cfg.DataDir, "volumes", u1)
	if err := os.WriteFile(filepath.Join(vol, "readme.txt"), []byte("hallo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return h, vol
}

func TestFilesAPI(t *testing.T) {
	h, vol := newFilesServer(t, 0)
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, "geheim"), []byte("x"), 0o644)
	_ = os.Symlink(outside, filepath.Join(vol, "uit"))
	base := "/api/servers/" + u1 + "/files"

	if c, b, _ := h.raw("PUT", base+"/contents?path=/map/a.txt", []byte("inhoud")); c != 204 {
		t.Fatal(c, string(b))
	}
	if c, b, _ := h.raw("GET", base+"/contents?path=/map/a.txt", nil); c != 200 || string(b) != "inhoud" {
		t.Fatal(c, string(b))
	}
	if fi, _ := os.Stat(filepath.Join(vol, "map", "a.txt")); fi == nil {
		t.Fatal("niet op schijf")
	}
	var list []map[string]any
	h.expect("GET", base+"/list?path=/", nil, 200).json(t, &list)
	if len(list) != 3 || list[0]["name"] != "map" || list[0]["is_directory"] != true {
		t.Fatalf("%v", list)
	}
	// Ontsnappen: .. en symlinks.
	h.expect("GET", base+"/list?path=/../", nil, 400)
	h.expect("GET", base+"/list?path=/uit", nil, 400)
	h.expect("GET", base+"/contents?path=/uit/geheim", nil, 400)
	if c, _, _ := h.raw("PUT", base+"/contents?path=/uit/nieuw", []byte("x")); c != 400 {
		t.Fatal("schrijven via symlink", c)
	}
	if _, err := os.Stat(filepath.Join(outside, "nieuw")); err == nil {
		t.Fatal("buiten de root geschreven")
	}
	h.expect("GET", base+"/contents?path=/bestaat-niet", nil, 404)
	h.expect("POST", base+"/mkdir", map[string]string{"path": "/plugins"}, 204)
	h.expect("POST", base+"/mkdir", map[string]string{"path": "/plugins"}, 409)
	h.expect("POST", base+"/rename", map[string]string{"from": "/map/a.txt", "to": "/plugins/b.txt"}, 204)
	h.expect("POST", base+"/rename", map[string]string{"from": "/plugins/b.txt", "to": "/readme.txt"}, 409)
	var arc map[string]any
	h.expect("POST", base+"/compress", map[string]any{"root": "/", "paths": []string{"plugins", "readme.txt"}}, 200).json(t, &arc)
	name, _ := arc["name"].(string)
	if !strings.HasSuffix(name, ".tar.gz") || arc["size"].(float64) == 0 {
		t.Fatal(arc)
	}
	h.expect("POST", base+"/delete", map[string]any{"paths": []string{"/plugins", "/readme.txt"}}, 204)
	h.expect("POST", base+"/decompress", map[string]string{"path": "/" + name}, 204)
	if c, b, _ := h.raw("GET", base+"/contents?path=/plugins/b.txt", nil); c != 200 || string(b) != "inhoud" {
		t.Fatal(c, string(b))
	}
	h.expect("POST", base+"/delete", map[string]any{"paths": []string{"/"}}, 400)
	h.expect("POST", base+"/delete", map[string]any{"paths": []string{"/uit"}}, 204)
	if _, err := os.Stat(filepath.Join(outside, "geheim")); err != nil {
		t.Fatal("doel van symlink verwijderd")
	}
	big := bytes.Repeat([]byte("x"), 5<<20+1)
	h.raw("PUT", base+"/contents?path=/groot", big)
	h.expect("GET", base+"/contents?path=/groot", nil, 413)
	if c := h.doTok("GET", base+"/list?path=/", nil, ""); c.Code != 401 {
		t.Fatal(c.Code)
	}
}

func TestTransfer(t *testing.T) {
	h, _ := newFilesServer(t, 0)
	sign := func(perms ...string) string {
		return h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: perms})
	}
	dl := func(tok, origin string) *http.Response {
		req, _ := http.NewRequest("GET", h.base+"/api/servers/"+u1+"/files/download?path=/readme.txt&token="+tok, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	tok := sign("files.read")
	res := dl(tok, "https://panel.test")
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(b) != "hallo\n" || !strings.Contains(res.Header.Get("Content-Disposition"), "readme.txt") ||
		res.Header.Get("Access-Control-Allow-Origin") != "https://panel.test" {
		t.Fatal(res.StatusCode, string(b), res.Header)
	}
	if res := dl(tok, ""); res.StatusCode != 401 {
		t.Fatal("tweede keer", res.StatusCode)
	}
	if res := dl(sign("files.write"), ""); res.StatusCode != 403 {
		t.Fatal("zonder files.read", res.StatusCode)
	}
	if res := dl(sign("files.read"), "https://evil.test"); res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS voor vreemde origin")
	}
	other := h.panel.Sign(testpanel.TokenOpts{Server: "0b7c2d1e-9999-4222-8333-444455556666", Permissions: []string{"files.read"}})
	if res := dl(other, ""); res.StatusCode != 401 {
		t.Fatal("ander server_uuid", res.StatusCode)
	}

	// Claims moeten bij de URL passen.
	if res := dl(h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"files.read"}, Path: "/ander.txt"}), ""); res.StatusCode != 403 {
		t.Fatal("path-claim genegeerd", res.StatusCode)
	}
	if res := dl(h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"files.read"}, Path: "/readme.txt"}), ""); res.StatusCode != 200 {
		t.Fatal("juiste path-claim", res.StatusCode)
	}

	// Preflight.
	req, _ := http.NewRequest("OPTIONS", h.base+"/api/servers/"+u1+"/files/upload?directory=/", nil)
	req.Header.Set("Origin", "https://panel.test")
	req.Header.Set("Access-Control-Request-Method", "POST")
	pre, err := http.DefaultClient.Do(req)
	if err != nil || pre.StatusCode != 204 || pre.Header.Get("Access-Control-Allow-Origin") != "https://panel.test" {
		t.Fatal(err, pre)
	}

	upload := func(tok, dir string, files map[string]string) int {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		for n, c := range files {
			w, _ := mw.CreateFormFile("files", n)
			_, _ = w.Write([]byte(c))
		}
		mw.Close()
		req, _ := http.NewRequest("POST", h.base+"/api/servers/"+u1+"/files/upload?directory="+dir+"&token="+tok, &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := upload(h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"files.write"}, Directory: "/plugins"}), "/", map[string]string{"a.txt": "a"}); c != 403 {
		t.Fatal("directory-claim genegeerd", c)
	}
	if c := upload(sign("files.read"), "/", map[string]string{"a.txt": "a"}); c != 403 {
		t.Fatal("upload zonder files.write", c)
	}
	if c := upload(sign("files.write"), "/plugins", map[string]string{"a.jar": "jar", "../../b.txt": "b"}); c != 204 {
		t.Fatal("upload", c)
	}
	if c, b, _ := h.raw("GET", "/api/servers/"+u1+"/files/contents?path=/plugins/b.txt", nil); c != 200 || string(b) != "b" {
		t.Fatal("../ in bestandsnaam hoort in de doelmap te landen", c, string(b))
	}
}

func TestDiskLimit(t *testing.T) {
	h, vol := newFilesServer(t, 1)
	base := "/api/servers/" + u1
	h.expect("POST", base+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	ws := h.ws(u1, nil)
	ws.send(map[string]string{"event": "auth", "token": h.panel.Sign(testpanel.TokenOpts{Server: u1, Permissions: []string{"console.read"}})})
	ws.next("auth_success", 2*time.Second, ev("auth_success"))

	// 950 KB = 93%: waarschuwing, server blijft draaien.
	if err := os.WriteFile(filepath.Join(vol, "a.bin"), make([]byte, 950<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	ws.next("waarschuwing", 3*time.Second, func(m map[string]any) bool { return m["event"] == "daemon_message" && m["level"] == "warning" })
	if c, b, _ := h.raw("PUT", base+"/files/contents?path=/x.bin", make([]byte, 200<<10)); c != 507 || !strings.Contains(string(b), "disk_exceeded") {
		t.Fatal("schrijven boven limiet", c, string(b))
	}
	if h.state(u1).State != "online" {
		t.Fatal("server gestopt onder de limiet")
	}
	// Erover: stoppen, status disk_exceeded, start geweigerd.
	if err := os.WriteFile(filepath.Join(vol, "b.bin"), make([]byte, 200<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	v := h.waitState(u1, "disk_exceeded", 5*time.Second)
	if !v.DiskExceeded {
		t.Fatal(v)
	}
	if c, _, _ := h.raw("PUT", base+"/files/contents?path=/y.txt", []byte("x")); c != 507 {
		t.Fatal(c)
	}
	r := h.expect("POST", base+"/power", map[string]string{"action": "start"}, 409)
	if !strings.Contains(string(r.Body), `"disk_exceeded"`) {
		t.Fatal(string(r.Body))
	}
	waitFor(t, "status naar panel", 2*time.Second, func() bool {
		s := h.panel.Statuses(u1)
		return len(s) > 0 && s[len(s)-1] == "disk_exceeded"
	})
	// Limiet verhogen: weer offline en startbaar.
	sp := testSpec(u1)
	sp["limits"] = map[string]any{"cpu_pct": 100, "memory_mb": 512, "swap_mb": 0, "disk_mb": 2}
	sp["config_files"] = []any{}
	var nv map[string]any
	h.expect("PUT", base, sp, 200).json(t, &nv)
	if nv["state"] != "offline" || nv["disk_exceeded"] != false {
		t.Fatal(nv)
	}
	h.expect("POST", base+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
}

func TestSFTP(t *testing.T) {
	h, _ := newFilesServer(t, 1)
	h.panel.AddSFTPUser("speler.0b7c2d1e", testpanel.SFTPUser{Password: "goed", Server: u1, Permissions: []string{"files.read", "files.write"}})
	h.panel.AddSFTPUser("helper.0b7c2d1e", testpanel.SFTPUser{Password: "goed", Server: u1, Permissions: []string{"files.read"}})
	h.panel.AddSFTPUser("ander.12345678", testpanel.SFTPUser{Password: "goed", Server: u1, Permissions: []string{"files.read"}})
	dial := func(user, pw string) (*sftp.Client, error) {
		c, err := ssh.Dial("tcp", h.d.SFTPAddr(), &ssh.ClientConfig{User: user, Auth: []ssh.AuthMethod{ssh.Password(pw)},
			HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
		if err != nil {
			return nil, err
		}
		s, err := sftp.NewClient(c)
		if err != nil {
			c.Close()
			return nil, err
		}
		t.Cleanup(func() { s.Close(); c.Close() })
		return s, nil
	}
	if _, err := dial("speler.0b7c2d1e", "fout"); err == nil {
		t.Fatal("fout wachtwoord geaccepteerd")
	}
	if _, err := dial("ander.12345678", "goed"); err == nil {
		t.Fatal("shortId past niet bij server_uuid")
	}
	calls := h.panel.Calls("/api/remote/sftp/auth")
	if len(calls) == 0 || calls[0].Body["ip"] != "127.0.0.1" {
		t.Fatal(calls)
	}
	s, err := dial("speler.0b7c2d1e", "goed")
	if err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(s.Mkdir("/plugins"))
	f, err := s.Create("/plugins/test.jar")
	must(err)
	_, err = f.Write([]byte("nep-jar"))
	must(err)
	must(f.Close())
	l, err := s.ReadDir("/plugins")
	must(err)
	if len(l) != 1 || l[0].Name() != "test.jar" || l[0].Size() != 7 {
		t.Fatal(l)
	}
	if _, err := s.Open("/../../etc/passwd"); err == nil {
		t.Fatal("ontsnapt")
	}
	must(s.Symlink("/etc", "/etc-link"))
	if _, err := s.ReadDir("/etc-link"); err == nil {
		t.Fatal("symlink naar buiten gevolgd")
	}
	must(s.Rename("/plugins/test.jar", "/plugins/b.jar"))
	var list []map[string]any
	h.expect("GET", "/api/servers/"+u1+"/files/list?path=/plugins", nil, 200).json(t, &list)
	if len(list) != 1 || list[0]["name"] != "b.jar" {
		t.Fatal(list)
	}
	// Disk-limiet tijdens schrijven (1 MB).
	f, err = s.Create("/groot.bin")
	must(err)
	_, err = f.Write(make([]byte, 2<<20))
	f.Close()
	if err == nil {
		t.Fatal("schrijven boven de limiet lukte")
	}

	ro, err := dial("helper.0b7c2d1e", "goed")
	must(err)
	if _, err := ro.ReadDir("/"); err != nil {
		t.Fatal(err)
	}
	rf, err := ro.Open("/readme.txt")
	must(err)
	b, _ := io.ReadAll(rf)
	rf.Close()
	if string(b) != "hallo\n" {
		t.Fatal(string(b))
	}
	if _, err := ro.Create("/mag-niet.txt"); err == nil {
		t.Fatal("schrijven zonder files.write")
	}
	if err := ro.Remove("/readme.txt"); err == nil {
		t.Fatal("verwijderen zonder files.write")
	}
}

func TestWebSiteNetwork(t *testing.T) {
	eng := engine.NewFake()
	if _, err := eng.Create(context.Background(), engine.ContainerConfig{Name: "panel-mariadb", Labels: map[string]string{"panel.role": "infra"}}); err != nil {
		t.Fatal(err)
	}
	router := proxy.NewFake()
	h := newHarness(t, eng, router, nil, "", nil, "")
	sp := testSpec(u1)
	sp["type"] = "web"
	sp["http_port"] = 8080
	h.expect("POST", "/api/servers", sp, 400) // web met allocations
	sp["allocations"] = []any{}
	sp["config_files"] = []any{}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "offline", 5*time.Second)
	net := "panel-site-" + u1
	n := eng.Network(net)
	if n == nil || n.Internal || n.Labels["panel.role"] != "site" || n.Labels["panel.managed"] != "true" || n.Labels["panel.instance"] != "unit" || !n.Connected["panel-mariadb"] {
		t.Fatalf("netwerk: %+v", n)
	}
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	cfg := eng.Container("panel-" + u1).Config
	if cfg.NetworkMode != net || len(cfg.Ports) != 0 {
		t.Fatalf("%+v", cfg)
	}
	h.expect("PUT", "/api/routes/site.test", map[string]any{"server_uuid": u1}, 200)
	rs := router.Routes()
	if len(rs) != 1 || rs[0].Upstream != (proxy.Upstream{Container: "panel-" + u1, Network: net, Port: 8080}) {
		t.Fatalf("%+v", rs)
	}
	// MariaDB herstart (koppeling weg): periodiek herstel.
	_ = eng.DisconnectNetwork(context.Background(), net, "panel-mariadb")
	h.d.Manager().ReconcileNetworks(context.Background())
	if !eng.Network(net).Connected["panel-mariadb"] {
		t.Fatal("MariaDB niet opnieuw gekoppeld")
	}
	h.expect("DELETE", "/api/servers/"+u1, nil, 204)
	if eng.Network(net) != nil || len(router.Routes()) != 0 {
		t.Fatal("netwerk of route niet opgeruimd")
	}
	if eng.Container("panel-mariadb") == nil {
		t.Fatal("MariaDB aangeraakt")
	}

	// Een netwerk met die naam dat niet van ons is: niet gebruiken.
	eng.AddNetwork(net, map[string]string{"panel.role": "infra"})
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "offline", 5*time.Second)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	time.Sleep(200 * time.Millisecond)
	if h.state(u1).State != "offline" {
		t.Fatal("gestart op een vreemd netwerk")
	}
	h.expect("DELETE", "/api/servers/"+u1, nil, 204)
	if eng.Network(net) == nil {
		t.Fatal("vreemd netwerk verwijderd")
	}
}

func TestReconcileReattachesRunningGame(t *testing.T) {
	eng := engine.NewFake()
	h := newHarness(t, eng, proxy.NewFake(), nil, "", nil, "")
	sp := testSpec(u1)
	sp["config_files"] = []any{}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u1, "offline", 5*time.Second)
	net := "panel-site-" + u1
	eng.AddNetwork(net, map[string]string{"panel.managed": "true", "panel.instance": "unit", "panel.role": "site"})
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	_ = eng.DisconnectNetwork(context.Background(), net, "panel-"+u1) // daemon-herstart: koppeling weg
	if eng.Network(net).Connected["panel-"+u1] {
		t.Fatal("testopzet")
	}
	h.d.Manager().ReconcileNetworks(context.Background())
	if !eng.Network(net).Connected["panel-"+u1] {
		t.Fatal("draaiende gameserver niet gekoppeld aan zijn site-netwerk")
	}
}

func TestFreeSpaceWatch(t *testing.T) {
	var full atomic.Bool
	h := newHarnessWith(t, engine.NewFake(), nil, nil, "", nil, "", func(_ *config.Config, d *Deps) {
		d.FreeInterval = 50 * time.Millisecond
		d.Statfs = func(string) (int64, int64, error) {
			if full.Load() {
				return 100, 3, nil
			}
			return 100, 50, nil
		}
	})
	const u2 = "0b7c2d1e-2222-4222-8333-444455556666"
	for _, u := range []string{u1, u2} {
		sp := testSpec(u)
		sp["limits"] = map[string]any{"cpu_pct": 100, "memory_mb": 512, "swap_mb": 0, "disk_mb": 0}
		sp["config_files"] = []any{}
		sp["allocations"] = []any{}
		sp["start_on_install"] = true
		h.expect("POST", "/api/servers", sp, 202)
		h.waitState(u, "online", 5*time.Second)
	}
	time.Sleep(300 * time.Millisecond) // eerste metingen
	if err := os.WriteFile(filepath.Join(h.cfg.DataDir, "volumes", u2, "groei.bin"), make([]byte, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "groei gemeten", 3*time.Second, func() bool { return h.state(u2).DiskBytes >= 1<<20 })
	full.Store(true)
	h.waitState(u2, "offline", 5*time.Second)
	time.Sleep(100 * time.Millisecond)
	if h.state(u1).State != "online" {
		t.Fatal("verkeerde server gestopt")
	}
}

func TestSitePlaceholder(t *testing.T) {
	eng := engine.NewFake()
	release := make(chan struct{}, 10)
	eng.Behavior = func(c *engine.FakeContainer) {
		if c.Config.Labels["panel.role"] == "install" {
			<-release
			c.Exit(0)
			return
		}
		engine.DefaultBehavior(c)
	}
	router := proxy.NewFake()
	dir := t.TempDir()
	h := newHarness(t, eng, router, nil, dir, nil, "")
	sp := testSpec(u1)
	sp["type"], sp["http_port"], sp["allocations"], sp["config_files"] = "web", 8080, []any{}, []any{}
	sp["limits"] = map[string]any{"cpu_pct": 100, "memory_mb": 512, "swap_mb": 0, "disk_mb": 1}
	h.expect("POST", "/api/servers", sp, 202)
	h.expect("PUT", "/api/routes/site.test", map[string]any{"server_uuid": u1}, 200)
	h.expect("PUT", "/api/routes/www.site.test", map[string]any{"server_uuid": u1, "redirect_to": "site.test"}, 200)
	ph := func(want proxy.Placeholder) {
		t.Helper()
		waitFor(t, "placeholder "+string(want), 3*time.Second, func() bool {
			for _, r := range router.Routes() {
				if r.Host == "www.site.test" && (r.Placeholder != "" || r.RedirectTo != "site.test") {
					t.Fatalf("redirect aangeraakt: %+v", r)
				}
				if r.Host == "site.test" {
					return r.Placeholder == want
				}
			}
			return false
		})
	}
	ph(proxy.PlaceholderInstalling)
	release <- struct{}{}
	h.waitState(u1, "offline", 5*time.Second)
	ph(proxy.PlaceholderOffline)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]string{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	ph(proxy.PlaceholderNone)
	if err := os.WriteFile(filepath.Join(dir, "volumes", u1, "vol.bin"), make([]byte, 2<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	h.waitState(u1, "disk_exceeded", 5*time.Second)
	ph(proxy.PlaceholderDisk)

	// Daemon-herstart: Sync zet de juiste placeholder, ook als Caddy alles kwijt is.
	h.stop()
	_ = router.Sync(context.Background(), nil)
	h.start()
	ph(proxy.PlaceholderDisk)
	_ = os.Remove(filepath.Join(dir, "volumes", u1, "vol.bin"))
	h.waitState(u1, "offline", 5*time.Second)
	ph(proxy.PlaceholderOffline)
	h.expect("POST", "/api/servers/"+u1+"/install", nil, 202)
	ph(proxy.PlaceholderInstalling)
	release <- struct{}{}
	h.waitState(u1, "offline", 5*time.Second)
	ph(proxy.PlaceholderOffline)
}

func TestMariaDBContainerFromEnv(t *testing.T) {
	eng := engine.NewFake()
	for _, n := range []string{"panel-mariadb", "it-mariadb"} {
		if _, err := eng.Create(context.Background(), engine.ContainerConfig{Name: n}); err != nil {
			t.Fatal(err)
		}
	}
	h := newHarnessWith(t, eng, nil, nil, "", nil, "", func(c *config.Config, _ *Deps) { c.MariaDBContainer = "it-mariadb" })
	sp := testSpec(u1)
	sp["type"], sp["http_port"], sp["allocations"], sp["config_files"] = "web", 8080, []any{}, []any{}
	h.expect("POST", "/api/servers", sp, 202)
	n := eng.Network("panel-site-" + u1)
	if n == nil || !n.Connected["it-mariadb"] || n.Connected["panel-mariadb"] {
		t.Fatalf("%+v", n)
	}
}
