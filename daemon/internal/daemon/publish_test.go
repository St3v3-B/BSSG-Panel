package daemon

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Staging (u2) publiceren naar productie (u1) via de API: werkmap vullen terwijl productie draait,
// omwisselen alleen als hij gestopt is, uitsluitingen, rollback en finish; en de tar-route voor andere nodes.
func TestPublishAPI(t *testing.T) {
	h, prod := newFilesServer(t, 0)
	sp := testSpec(u2)
	sp["config_files"] = []any{}
	h.expect("POST", "/api/servers", sp, 202)
	h.waitState(u2, "offline", 5*time.Second)
	stag := filepath.Join(h.cfg.DataDir, "volumes", u2)
	put := func(dir, rel, c string) {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755)
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	get := func(dir, rel string) string {
		b, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			return "<missing>"
		}
		return string(b)
	}
	put(prod, "wp-config.php", "prod")
	put(prod, "public/index.php", "v1")
	put(stag, "wp-config.php", "staging")
	put(stag, "public/index.php", "v2")
	put(stag, ".panel-deploy/x", "deploy-staging")

	base := "/api/servers/" + u1 + "/publish/"
	h.expect("POST", base+"0/copy", map[string]any{"source_uuid": u2}, 400)
	h.expect("POST", base+"1/copy", map[string]any{"source_uuid": u1}, 400)
	h.expect("POST", base+"1/swap", map[string]any{"exclude": []string{}}, 404) // niet voorbereid

	// Productie draait: vullen mag, omwisselen niet.
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]any{"action": "start"}, 202)
	h.waitState(u1, "online", 5*time.Second)
	h.expect("POST", base+"1/copy", map[string]any{"source_uuid": u2}, 204)
	if get(prod, ".panel-publish-1/new/public/index.php") != "v2" || get(prod, ".panel-publish-1/new/.panel-deploy/x") != "<missing>" {
		t.Fatal("werkmap niet goed gevuld")
	}
	h.expect("POST", base+"1/swap", map[string]any{"exclude": []string{"wp-config.php"}}, 409)
	h.expect("POST", "/api/servers/"+u1+"/power", map[string]any{"action": "stop"}, 202)
	h.waitState(u1, "offline", 5*time.Second)
	h.expect("POST", base+"1/swap", map[string]any{"exclude": []string{"../x"}}, 400)
	h.expect("POST", base+"1/swap", map[string]any{"exclude": []string{"wp-config.php"}}, 200)
	if get(prod, "public/index.php") != "v2" || get(prod, "wp-config.php") != "prod" || get(prod, "readme.txt") != "<missing>" {
		t.Fatal("swap", get(prod, "public/index.php"), get(prod, "wp-config.php"))
	}
	// Rollback: alles terug.
	h.expect("POST", base+"1/rollback", nil, 204)
	if get(prod, "public/index.php") != "v1" || get(prod, "readme.txt") != "hallo\n" {
		t.Fatal("rollback", get(prod, "public/index.php"))
	}
	if _, err := os.Stat(filepath.Join(prod, ".panel-publish-1")); !os.IsNotExist(err) {
		t.Fatal("werkmap na rollback")
	}

	// Andere node: export van staging (zonder .panel-*) als tar naar /data.
	c, tarball, _ := h.raw("GET", "/api/servers/"+u2+"/transfer/export?live=1&exclude_internal=1", nil)
	if c != 200 {
		t.Fatal("export", c)
	}
	if c, b, _ := h.raw("PUT", base+"2/data", tarball); c != 204 {
		t.Fatal("data", c, string(b))
	}
	h.expect("POST", base+"2/swap", map[string]any{"exclude": []string{"wp-config.php"}}, 200)
	h.expect("DELETE", base+"2", nil, 204)
	if get(prod, "public/index.php") != "v2" || get(prod, "wp-config.php") != "prod" || get(prod, ".panel-deploy/x") != "<missing>" {
		t.Fatal("publish via tar")
	}
	if _, err := os.Stat(filepath.Join(prod, ".panel-publish-2")); !os.IsNotExist(err) {
		t.Fatal("werkmap na finish")
	}
}
