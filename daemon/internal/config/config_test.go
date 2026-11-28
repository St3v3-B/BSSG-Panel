package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(map[string]string{"NODE_TOKEN": "t", "NODE_DOMAIN": "Node1.test", "PANEL_DOMAIN": "panel.test"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PanelURL != "https://panel.test" || c.NodeDomain != "node1.test" || c.DaemonPort != 8080 || c.SFTPPort != 2022 ||
		c.DataDir != "/var/lib/panel" || c.DaemonSocket != "/run/panel/daemon.sock" || c.Instance != "main" || c.CaddyAdminURL != "" || c.MariaDBContainer != "panel-mariadb" || c.ImageCheckInterval != 24*time.Hour {
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
		"DOCKER_EXTRA_LABELS": "panel.test=true, a=b", "MARIADB_CONTAINER": "it-mariadb", "IMAGE_CHECK_INTERVAL": "0",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.PanelURL != "http://127.0.0.1:4000" || c.DaemonPort != 0 || c.Instance != "it-1" || c.MariaDBContainer != "it-mariadb" || c.ImageCheckInterval != 0 || c.ExtraLabels["panel.test"] != "true" || c.ExtraLabels["a"] != "b" {
		t.Fatalf("%+v", c)
	}
	o := c.AllowedOrigins()
	if len(o) != 2 || o[1] != "http://127.0.0.1:4000" {
		t.Fatal(o)
	}
}

func TestLoadErrors(t *testing.T) {
	_, err := Load(env(map[string]string{"DAEMON_PORT": "x", "IMAGE_CHECK_INTERVAL": "soon", "DOCKER_EXTRA_LABELS": "panel.managed=false"}))
	for _, want := range []string{"NODE_TOKEN", "NODE_DOMAIN", "PANEL_URL", "DAEMON_PORT", "IMAGE_CHECK_INTERVAL", "voorbehouden"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("mist %s in %v", want, err)
		}
	}
	if _, err := ParseLabels("zonderis"); err == nil {
		t.Error("label zonder =")
	}
}

func TestNetworkPool(t *testing.T) {
	base := map[string]string{"NODE_TOKEN": "t", "NODE_DOMAIN": "node1.test", "PANEL_DOMAIN": "panel.test"}
	with := func(v string) (Config, error) {
		m := map[string]string{"DOCKER_NETWORK_POOL": v}
		for k, x := range base {
			m[k] = x
		}
		return Load(env(m))
	}
	if c, err := with(""); err != nil || c.NetworkPool.String() != "10.213.0.0/16" {
		t.Fatal(c.NetworkPool, err)
	}
	if c, err := with("10.99.1.0/20"); err != nil || c.NetworkPool.String() != "10.99.0.0/20" {
		t.Fatal(c.NetworkPool, err)
	}
	if c, err := with("docker"); err != nil || c.NetworkPool.IsValid() {
		t.Fatal(c.NetworkPool, err)
	}
	for _, bad := range []string{"10.0.0.0/28", "fd00::/48", "nonsense"} {
		if _, err := with(bad); err == nil || !strings.Contains(err.Error(), "DOCKER_NETWORK_POOL") {
			t.Fatal(bad, err)
		}
	}
}

func TestLoadHTTPModeNPM(t *testing.T) {
	base := map[string]string{"NODE_TOKEN": "t", "NODE_DOMAIN": "node1.test", "PANEL_DOMAIN": "panel.test"}
	c, err := Load(env(base))
	if err != nil || c.HTTPMode != "direct" || c.NPMCaddyAddr != "172.17.0.1:8081" {
		t.Fatalf("%+v %v", c, err)
	}
	base["HTTP_MODE"], base["NPM_CADDY_ADDR"] = "NPM", "10.9.0.1:9000"
	if c, err = Load(env(base)); err != nil || c.HTTPMode != "npm" || c.NPMCaddyAddr != "10.9.0.1:9000" {
		t.Fatalf("%+v %v", c, err)
	}
	base["NPM_CADDY_ADDR"] = "nope"
	if _, err = Load(env(base)); err == nil || !strings.Contains(err.Error(), "NPM_CADDY_ADDR") {
		t.Fatal(err)
	}
	base["HTTP_MODE"], base["NPM_CADDY_ADDR"] = "nginx", ""
	if _, err = Load(env(base)); err == nil || !strings.Contains(err.Error(), "HTTP_MODE") {
		t.Fatal(err)
	}
}

func TestMailConfig(t *testing.T) {
	c, err := Load(env(map[string]string{"NODE_TOKEN": "t", "NODE_DOMAIN": "node1.test", "PANEL_DOMAIN": "panel.test"}))
	if err != nil {
		t.Fatal(err)
	}
	m := c.Mail
	if m.Hostname != "" || m.EnvFile != "/etc/panel/panel.env" || m.Postfix != "panel-postfix" || m.Rspamd != "panel-rspamd" ||
		m.DKIMDir != "/var/lib/rspamd/dkim" || m.VmailDir != "/var/vmail" || m.Profile != "mail" || m.NTPServer != "pool.ntp.org" {
		t.Fatalf("%+v", m)
	}
	c, _ = Load(env(map[string]string{"NODE_TOKEN": "t", "NODE_DOMAIN": "node1.test", "PANEL_DOMAIN": "panel.test",
		"MAIL_HOSTNAME": "Mail.Panel.Test", "MAIL_DOVECOT_CONTAINER": "x-dovecot", "MAIL_DNSBL_RESOLVER": "system"}))
	if c.Mail.Hostname != "mail.panel.test" || c.Mail.Dovecot != "x-dovecot" || c.Mail.DNSBLResolver != "system" {
		t.Fatalf("%+v", c.Mail)
	}
}
