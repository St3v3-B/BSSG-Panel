package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"panel/daemon/internal/config"
	"panel/daemon/internal/engine"
)

func (h *harness) rawDB(method, path, ctype string, body io.Reader) (int, []byte) {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.base+path, body)
	req.Header.Set("Authorization", "Bearer "+nodeToken)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

func TestDBEndpointsWithoutMariaDB(t *testing.T) {
	h := newHarness(t, engine.NewFake(), nil, nil, "", nil, "")
	var st map[string]any
	h.expect("GET", "/api/db/status", nil, 200).json(t, &st)
	if st["available"] != false {
		t.Fatal(st)
	}
	h.expect("POST", "/api/db/databases", map[string]string{"name": "a", "username": "b", "password": "12345678"}, 503)
	if r := h.doTok("GET", "/api/db/status", nil, ""); r.Code != 401 {
		t.Fatal("zonder token", r.Code)
	}
	// Hello meldt geen MariaDB.
	waitFor(t, "hello", 2*time.Second, func() bool { return len(h.panel.Calls("/api/remote/node/hello")) == 1 })
	if c := h.panel.Calls("/api/remote/node/hello")[0]; c.Body["has_mariadb"] != false {
		t.Fatal(c.Body)
	}
}

// TestRealDockerDBAdmin: een echte MariaDB (eigen testcontainer, zoals in compose: non-root, read-only).
func TestRealDockerDBAdmin(t *testing.T) {
	if os.Getenv("PANEL_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("PANEL_SKIP_DOCKER_TESTS=1")
	}
	eng, err := engine.NewDocker()
	if err != nil {
		t.Skip("geen Docker:", err)
	}
	ctx := context.Background()
	if _, err := eng.Version(ctx); err != nil {
		t.Skip("geen Docker:", err)
	}
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.EnsureImage(ctx, "mariadb:11", nil); err != nil {
		t.Skip("image niet beschikbaar:", err)
	}
	instance := fmt.Sprintf("node-db-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	labels := map[string]string{"panel.test": "true", "panel.instance": instance}
	t.Cleanup(func() {
		f := filters.NewArgs(filters.Arg("label", "panel.test=true"), filters.Arg("label", "panel.instance="+instance))
		list, _ := cli.ContainerList(context.Background(), container.ListOptions{All: true, Filters: f})
		for _, c := range list {
			_ = cli.ContainerRemove(context.Background(), c.ID, container.RemoveOptions{Force: true})
		}
		nets, _ := cli.NetworkList(context.Background(), network.ListOptions{Filters: f})
		for _, n := range nets {
			_ = cli.NetworkRemove(context.Background(), n.ID)
		}
	})
	dbName := "panel-mariadb-" + instance
	hc := &container.HostConfig{ReadonlyRootfs: true, Tmpfs: map[string]string{"/tmp": "uid=999,gid=999", "/run/mysqld": "uid=999,gid=999"}, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"}}
	if _, err := cli.ContainerCreate(ctx, &container.Config{Image: "mariadb:11", User: "999:999", Env: []string{"MARIADB_ROOT_PASSWORD=rootpw-" + instance}, Labels: labels, Cmd: []string{"--skip-name-resolve"}}, hc, nil, nil, dbName); err != nil {
		t.Fatal(err)
	}
	if err := cli.ContainerStart(ctx, dbName, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	// Als gewone gebruiker verbinden (TCP op localhost in de container).
	as := func(user, pw, db, q string) (string, int) {
		ex, _ := cli.ContainerExecCreate(ctx, dbName, container.ExecOptions{Cmd: []string{"mariadb", "-h127.0.0.1", "-u" + user, "-N", "-B", db, "-e", q}, Env: []string{"MYSQL_PWD=" + pw}, AttachStdout: true, AttachStderr: true})
		att, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
		if err != nil {
			t.Fatal(err)
		}
		var ob, eb bytes.Buffer
		_, _ = stdcopy.StdCopy(&ob, &eb, att.Reader)
		att.Close()
		for i := 0; i < 100; i++ {
			if r, err := cli.ContainerExecInspect(ctx, ex.ID); err == nil && !r.Running {
				return strings.TrimSpace(ob.String() + eb.String()), r.ExitCode
			}
			time.Sleep(50 * time.Millisecond)
		}
		return "", -1
	}
	rootpw := "rootpw-" + instance

	// Daemon die later start dan de MariaDB bestaat: hello meldt eerst "geen", daarna via de watcher "wel".
	h := newHarnessWith(t, eng, nil, nil, "", map[string]string{"panel.test": "true"}, instance, func(c *config.Config, d *Deps) {
		c.MariaDBContainer = dbName
		c.MariaDBRootPassword = rootpw
		d.DBWatchInterval = 300 * time.Millisecond
	})
	waitFor(t, "MariaDB klaar", 90*time.Second, func() bool {
		var st struct{ Available bool }
		h.expect("GET", "/api/db/status", nil, 200).json(t, &st)
		return st.Available
	})
	waitFor(t, "hello met has_mariadb=true", 10*time.Second, func() bool {
		for _, c := range h.panel.Calls("/api/remote/node/hello") {
			if c.Body["has_mariadb"] == true {
				return true
			}
		}
		return false
	})
	var st map[string]any
	h.expect("GET", "/api/db/status", nil, 200).json(t, &st)
	if st["host"] != dbName {
		t.Fatal(st)
	}

	create := func(name, user, pw string) int {
		return h.do("POST", "/api/db/databases", map[string]string{"name": name, "username": user, "password": pw}).Code
	}
	// Validatie: nooit SQL-injectie via namen of wachtwoord.
	for _, bad := range [][3]string{
		{"a`; DROP DATABASE mysql; --", "u1", "password123"},
		{"ok_db", "u1'; DROP USER root; --", "password123"},
		{"ok_db", "u1", "pass'word123"},
		{"ok_db", "u1", `pass\word123`},
		{"ok_db", "u1", "short"},
		{"", "u1", "password123"},
		{strings.Repeat("a", 65), "u1", "password123"},
	} {
		if c := create(bad[0], bad[1], bad[2]); c != 400 {
			t.Errorf("%q: %d, verwacht 400", bad, c)
		}
	}
	if c := h.do("DELETE", "/api/db/databases/x?username=y%27", nil).Code; c != 400 {
		t.Errorf("drop met ongeldige gebruiker: %d", c)
	}

	pw1 := "S3cret!pa$$w0rd#1"
	// De officiele image herstart MariaDB na de init; vlak daarna kan een verzoek nog 503 geven.
	c1 := 0
	waitFor(t, "eerste create", 60*time.Second, func() bool { c1 = create("s1234_site", "u1234_a", pw1); return c1 != 503 })
	if c := c1; c != 204 {
		t.Fatal("create", c)
	}
	if c := create("s1234_site", "u1234_b", pw1); c != 409 {
		t.Fatal("dubbel", c)
	}
	// Mislukte create (gebruiker bestaat al) laat geen losse database achter.
	if c := create("s1234_other", "u1234_a", pw1); c != 409 {
		t.Fatal("dubbele gebruiker", c)
	}
	if out, _ := as("root", rootpw, "", "SHOW DATABASES LIKE 's1234_other'"); out != "" {
		t.Fatalf("losse database achtergebleven: %q", out)
	}
	// De gebruiker werkt, en alleen op zijn eigen database.
	if out, code := as("u1234_a", pw1, "s1234_site", "CREATE TABLE notes (id INT PRIMARY KEY, txt VARCHAR(50) CHARACTER SET utf8mb4); INSERT INTO notes VALUES (1,'één'),(2,'twee 🙂'); SELECT COUNT(*) FROM notes"); code != 0 || out != "2" {
		t.Fatalf("gebruiker: %d %q", code, out)
	}
	if _, code := as("u1234_a", pw1, "mysql", "SELECT 1 FROM user LIMIT 1"); code == 0 {
		t.Fatal("gebruiker mag mysql lezen")
	}
	// Jokerteken: s1234xsite valt niet onder de rechten van s1234_site.
	if _, code := as("root", rootpw, "", "CREATE DATABASE s1234xsite"); code != 0 {
		t.Fatal("kon testdb niet maken")
	}
	if _, code := as("u1234_a", pw1, "s1234xsite", "SELECT 1"); code == 0 {
		t.Fatal("underscore in GRANT werkt als jokerteken")
	}

	// Wachtwoord resetten.
	pw2 := "An0ther-Pass.word~2"
	h.expect("PUT", "/api/db/databases/s1234_site/password", map[string]string{"username": "u1234_a", "password": pw2}, 204)
	if _, code := as("u1234_a", pw1, "s1234_site", "SELECT 1"); code == 0 {
		t.Fatal("oud wachtwoord werkt nog")
	}
	if _, code := as("u1234_a", pw2, "s1234_site", "SELECT 1"); code != 0 {
		t.Fatal("nieuw wachtwoord werkt niet")
	}
	h.expect("PUT", "/api/db/databases/s1234_site/password", map[string]string{"username": "bestaat_niet", "password": pw2}, 404)

	// Dump -> import in een nieuwe database (andere naam) met dezelfde inhoud.
	code, dump := h.rawDB("GET", "/api/db/databases/s1234_site/dump", "", nil)
	if code != 200 || !bytes.Contains(dump, []byte("CREATE TABLE `notes`")) || !bytes.Contains(dump, []byte("twee 🙂")) {
		t.Fatalf("dump: %d %.200s", code, dump)
	}
	if c, _ := h.rawDB("GET", "/api/db/databases/bestaat_niet/dump", "", nil); c != 404 {
		t.Fatal("dump van onbekende db", c)
	}
	if c, _ := h.rawDB("PUT", "/api/db/databases/niet_gemaakt/import", "application/sql", bytes.NewReader(dump)); c != 404 {
		t.Fatal("import zonder database", c)
	}
	if c := create("s9999_copy", "u9999_c", pw1); c != 204 {
		t.Fatal(c)
	}
	if c, b := h.rawDB("PUT", "/api/db/databases/s9999_copy/import", "application/sql", bytes.NewReader(dump)); c != 204 {
		t.Fatalf("import: %d %s", c, b)
	}
	if out, code := as("u9999_c", pw1, "s9999_copy", "SELECT txt FROM notes WHERE id=2"); code != 0 || out != "twee 🙂" {
		t.Fatalf("kopie: %d %q", code, out)
	}
	// Kapotte SQL geeft een fout met uitleg.
	if c := create("s9998_bad", "u9998_b", pw1); c != 204 {
		t.Fatal(c)
	}
	c, b := h.rawDB("PUT", "/api/db/databases/s9998_bad/import", "application/sql", strings.NewReader("CREATE TABLE ("))
	var e struct{ Error string }
	_ = json.Unmarshal(b, &e)
	if c != 500 || e.Error != "import_failed" {
		t.Fatalf("kapotte import: %d %s", c, b)
	}

	// phpMyAdmin-account: ziet en bewerkt precies de opgegeven databases.
	pma := func(user, pw string, dbs []string) int {
		return h.do("PUT", "/api/db/pma-users/"+user, map[string]any{"password": pw, "databases": dbs}).Code
	}
	for _, bad := range []struct {
		user string
		dbs  []string
	}{
		{"root", nil}, {"u1234_a", nil}, {"pma_u1'; DROP USER root; --", nil}, {"pma_u", nil},
		{"pma_u7", []string{"mysql"}}, {"pma_u7", []string{"Information_Schema"}}, {"pma_u7", []string{"sys"}},
		{"pma_u7", []string{"performance_schema"}}, {"pma_u7", []string{"a`; GRANT ALL ON *.* TO pma_u7; --"}}, {"pma_u7", []string{"%"}},
	} {
		if c := pma(bad.user, "password123", bad.dbs); c != 400 && c != 404 {
			t.Errorf("pma %q %q: %d, verwacht 400", bad.user, bad.dbs, c)
		}
	}
	if c := pma("pma_u7", "kort", nil); c != 400 {
		t.Errorf("kort wachtwoord: %d", c)
	}
	pmaPw := "Pma-p4ss.word~1"
	if c := pma("pma_u7", pmaPw, []string{"s1234_site", "s9999_copy"}); c != 204 {
		t.Fatal("pma sync", c)
	}
	if out, code := as("pma_u7", pmaPw, "", "SHOW DATABASES"); code != 0 || out != "information_schema\ns1234_site\ns9999_copy" {
		t.Fatalf("pma ziet: %d %q", code, out)
	}
	if out, code := as("pma_u7", pmaPw, "s1234_site", "INSERT INTO notes VALUES (3,'pma'); SELECT COUNT(*) FROM notes"); code != 0 || out != "3" {
		t.Fatalf("pma schrijft: %d %q", code, out)
	}
	if _, code := as("pma_u7", pmaPw, "s1234xsite", "SELECT 1"); code == 0 {
		t.Fatal("pma: underscore werkt als jokerteken")
	}
	if _, code := as("pma_u7", pmaPw, "mysql", "SELECT 1 FROM user LIMIT 1"); code == 0 {
		t.Fatal("pma mag mysql lezen")
	}
	if out, _ := as("root", rootpw, "", "SHOW GRANTS FOR 'pma_u7'@'%'"); strings.Contains(strings.ToUpper(out), "GRANT OPTION") {
		t.Fatalf("pma grants: %q", out)
	}
	// Tweede sync: nieuw wachtwoord, rechten worden exact vervangen (s9999_copy weg, oud wachtwoord ongeldig).
	pmaPw2 := "Pma-p4ss.word~2"
	if c := pma("pma_u7", pmaPw2, []string{"s1234_site"}); c != 204 {
		t.Fatal("pma sync 2", c)
	}
	if _, code := as("pma_u7", pmaPw, "s1234_site", "SELECT 1"); code == 0 {
		t.Fatal("oud pma-wachtwoord werkt nog")
	}
	if out, code := as("pma_u7", pmaPw2, "", "SHOW DATABASES"); code != 0 || out != "information_schema\ns1234_site" {
		t.Fatalf("pma ziet na sync 2: %d %q", code, out)
	}
	if c := pma("pma_u7", pmaPw2, nil); c != 204 {
		t.Fatal("pma sync leeg", c)
	}
	if out, _ := as("pma_u7", pmaPw2, "", "SHOW DATABASES"); out != "information_schema" {
		t.Fatalf("pma zonder rechten ziet: %q", out)
	}

	// Verwijderen (twee keer: idempotent).
	for i := 0; i < 2; i++ {
		h.expect("DELETE", "/api/db/databases/s1234_site?username=u1234_a", nil, 204)
	}
	if out, _ := as("root", rootpw, "", "SELECT COUNT(*) FROM mysql.user WHERE User='u1234_a'"); out != "0" {
		t.Fatalf("gebruiker niet weg: %q", out)
	}
	if out, _ := as("root", rootpw, "", "SHOW DATABASES LIKE 's1234\\_site'"); out != "" {
		t.Fatalf("database niet weg: %q", out)
	}
}
