package config

import (
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"NODE_TOKEN": "t", "NODE_DOMAIN": "Node1.test", "PANEL_DOMAIN": "panel.test"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PanelURL != "https://panel.test" || c.NodeDomain != "node1.test" || c.DaemonPort != 8080 || c.SFTPPort != 2022 ||
		c.DataDir != "/var/lib/panel" || c.DaemonSocket != "/run/panel/daemon.sock" || c.Instance != "main" || c.CaddyAdminURL != "" || c.MariaDBContainer != "panel-mariadb" {
		t.Fatalf("%+v", c)
	}
	if o := c.AllowedOrigins(); len(o) != 1 || o[0] != "https://panel.test" {
		t.Fatal(o)
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"NODE_TOKEN": "t", "NODE_DOMAIN": "node1.test", "PANEL_DOMAIN": "panel.test",
		"PANEL_URL": "http://127.0.0.1:4000/", "DAEMON_PORT": "0", "PANEL_INSTANCE": "it-1",
		"DOCKER_EXTRA_LABELS": "panel.test=true, a=b", "MARIADB_CONTAINER": "it-mariadb",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PanelURL != "http://127.0.0.1:4000" || c.DaemonPort != 0 || c.Instance != "it-1" || c.MariaDBContainer != "it-mariadb" || c.ExtraLabels["panel.test"] != "true" || c.ExtraLabels["a"] != "b" {
		t.Fatalf("%+v", c)
	}
	o := c.AllowedOrigins()
	if len(o) != 2 || o[1] != "http://127.0.0.1:4000" {
		t.Fatal(o)
	}
}

func TestLoadErrors(t *testing.T) {
	_, err := Load(env(map[string]string{"DAEMON_PORT": "x", "DOCKER_EXTRA_LABELS": "panel.managed=false"}))
	for _, want := range []string{"NODE_TOKEN", "NODE_DOMAIN", "PANEL_URL", "DAEMON_PORT", "voorbehouden"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("mist %s in %v", want, err)
		}
	}
	if _, err := ParseLabels("zonderis"); err == nil {
		t.Error("label zonder =")
	}
}
