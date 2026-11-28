package mail

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"panel/daemon/internal/engine"
)

var mailLabels = map[string]string{"panel.managed": "true", "panel.instance": "main", "panel.role": "mail"}

func newTestService(t *testing.T, hostname string) (*Service, *FakeDocker) {
	t.Helper()
	fd := NewFakeDocker()
	for i, n := range []string{"panel-postfix", "panel-dovecot", "panel-rspamd", "panel-unbound"} {
		fd.Add(engine.ContainerSummary{ID: strings.Repeat(string(rune('a'+i)), 64), Name: n, Labels: mailLabels, State: "running", Health: "healthy"})
	}
	s := New(Config{Hostname: hostname, EnvFile: filepath.Join(t.TempDir(), "missing.env")}, fd, nil)
	return s, fd
}

func TestLabelsAreRequired(t *testing.T) {
	fd := NewFakeDocker()
	// Zelfde naam, maar zonder role=mail of met een ander instance: nooit aanspreken.
	fd.Add(engine.ContainerSummary{ID: "x1", Name: "panel-postfix", Labels: map[string]string{"panel.managed": "true", "panel.instance": "main", "panel.role": "infra"}, State: "running"})
	fd.Add(engine.ContainerSummary{ID: "x2", Name: "panel-dovecot", Labels: map[string]string{"panel.managed": "true", "panel.instance": "other", "panel.role": "mail"}, State: "running"})
	s := New(Config{Hostname: "mail.panel.test", EnvFile: "/nonexistent"}, fd, nil)
	ctx := context.Background()
	if _, err := s.Queue(ctx); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("queue: %v", err)
	}
	if _, err := s.Quota(ctx, []string{"a@panel.test"}); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("quota: %v", err)
	}
	if err := s.Reload(ctx); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("reload: %v", err)
	}
	if len(fd.Calls()) != 0 {
		t.Fatalf("exec on non-mail containers: %+v", fd.Calls())
	}
	st, err := s.Status(ctx)
	if err != nil || st.Enabled || len(st.Containers) != 0 {
		t.Fatalf("status %+v %v", st, err)
	}
}

func TestStatus(t *testing.T) {
	s, fd := newTestService(t, "mail.panel.test")
	fd.Add(engine.ContainerSummary{ID: "c-clam", Name: "panel-clamav", Labels: mailLabels, State: "exited"})
	fd.Handler = func(c string, argv []string, _ string) (string, string, int, bool) {
		switch {
		case c == "panel-postfix" && slices.Equal(argv, []string{"postqueue", "-j"}):
			return `{"queue_name":"deferred","queue_id":"4F3C21A3","arrival_time":1700000000,"message_size":2186,"sender":"a@panel.test","recipients":[{"address":"b@node1.test","delay_reason":"connection timed out"}]}
{"queue_name":"active","queue_id":"5A","arrival_time":1700000001,"message_size":10,"sender":"","recipients":[{"address":"c@node1.test"}]}
{"queue_name":"hold","queue_id":"6B6B6","arrival_time":1700000002,"message_size":10,"sender":"x@panel.test","recipients":[]}
{"queue_name":"incoming","queue_id":"7C7C7","arrival_time":1700000003,"message_size":10,"sender":"x@panel.test","recipients":[]}
`, "", 0, true
		case c == "panel-dovecot" && argv[0] == "du":
			return "2048\t/var/vmail\n", "", 0, true
		}
		return "", "", 0, false
	}
	st, err := s.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Enabled || !st.Configured || st.Hostname != "mail.panel.test" || len(st.Containers) != 5 {
		t.Fatalf("%+v", st)
	}
	if st.Containers[0].Name != "panel-clamav" || st.Containers[0].State != "exited" || st.Containers[1].Health != "healthy" {
		t.Fatalf("containers %+v", st.Containers)
	}
	if st.Queue != (QueueCounts{Active: 2, Deferred: 1, Hold: 1}) {
		t.Fatalf("queue %+v", st.Queue)
	}
	if st.VmailBytes == nil || *st.VmailBytes != 2048*1024 {
		t.Fatalf("vmail %v", st.VmailBytes)
	}
	for _, c := range fd.Calls() {
		if c.User != "0" {
			t.Fatalf("exec not as root: %+v", c)
		}
	}
}

func TestQueue(t *testing.T) {
	s, fd := newTestService(t, "mail.panel.test")
	fd.Handler = func(c string, argv []string, _ string) (string, string, int, bool) {
		if argv[0] == "postqueue" && argv[1] == "-j" {
			return `{"queue_name":"deferred","queue_id":"4F3C21A3","arrival_time":1700000000,"message_size":2186,"sender":"a@panel.test","recipients":[{"address":"b@node1.test","delay_reason":"timeout"},{"address":"c@node1.test"}]}` + "\nnot json\n", "", 0, true
		}
		if argv[0] == "postsuper" {
			if argv[2] == "AAAAA" {
				return "", "postsuper: Deleted: 0 messages\n", 0, true
			}
			return "", "postsuper: 4F3C21A3: removed\npostsuper: Deleted: 1 message\n", 0, true
		}
		return "", "", 0, false
	}
	ctx := context.Background()
	items, err := s.Queue(ctx)
	if err != nil || len(items) != 1 {
		t.Fatalf("%+v %v", items, err)
	}
	it := items[0]
	if it.QueueID != "4F3C21A3" || it.Size != 2186 || it.Reason != "timeout" || !slices.Equal(it.Recipients, []string{"b@node1.test", "c@node1.test"}) || it.ArrivalTime.Unix() != 1700000000 {
		t.Fatalf("%+v", it)
	}
	if err := s.FlushQueue(ctx); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"ALL", "all", "-", "", "4F3C;rm", "../x", "4F 3C", "-d"} {
		if err := s.DeleteQueued(ctx, bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if err := s.DeleteQueued(ctx, "AAAAA"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := s.DeleteQueued(ctx, "4F3C21A3"); err != nil {
		t.Fatal(err)
	}
	var argvs []string
	for _, c := range fd.Calls() {
		argvs = append(argvs, strings.Join(c.Argv, " "))
	}
	want := []string{"postqueue -j", "postqueue -f", "postsuper -d AAAAA", "postsuper -d 4F3C21A3"}
	if !slices.Equal(argvs, want) {
		t.Fatalf("%v", argvs)
	}
}

func testKey(t *testing.T) string {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := x509.MarshalPKCS8PrivateKey(k)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: b}))
}

func TestDKIM(t *testing.T) {
	s, fd := newTestService(t, "mail.panel.test")
	ctx := context.Background()
	dir := "/var/lib/rspamd/dkim"
	fd.Files["panel-rspamd"] = map[string]string{
		dir + "/panel.test.old.key":     "OLD",
		dir + "/panel.test.au.dkim.key": "OTHER DOMAIN",
		dir + "/selectors.map":          "panel.test old\npanel.test.au dkim\n",
	}
	reloadFails := true
	fd.Handler = func(c string, argv []string, _ string) (string, string, int, bool) {
		if argv[0] == "rspamadm" {
			if reloadFails {
				return "", "control socket missing", 1, true
			}
			return "", "", 0, true
		}
		return "", "", 0, false
	}
	key := testKey(t)
	if err := s.PutDKIM(ctx, "Panel.Test", "dkim", key); err != nil {
		t.Fatal(err)
	}
	files := fd.Files["panel-rspamd"]
	if strings.TrimSpace(files[dir+"/panel.test.dkim.key"]) != strings.TrimSpace(key) {
		t.Fatalf("key file: %q", files[dir+"/panel.test.dkim.key"])
	}
	if fd.Modes["panel-rspamd"+dir+"/panel.test.dkim.key"] != "0640" {
		t.Fatalf("mode %v", fd.Modes)
	}
	if _, ok := files[dir+"/panel.test.old.key"]; ok {
		t.Fatal("old selector key not removed")
	}
	if files[dir+"/panel.test.au.dkim.key"] != "OTHER DOMAIN" {
		t.Fatal("key of another domain touched")
	}
	m := files[dir+"/selectors.map"]
	if !strings.Contains(m, "\npanel.test dkim\n") || !strings.Contains(m, "\npanel.test.au dkim\n") || strings.Contains(m, " old") {
		t.Fatalf("selectors.map: %q", m)
	}
	if sig := fd.Signals(); !slices.Equal(sig, []string{"panel-rspamd HUP"}) {
		t.Fatalf("fallback SIGHUP: %v", sig)
	}
	for _, c := range fd.Calls() {
		if c.Container != "panel-rspamd" {
			t.Fatalf("dkim exec in %s", c.Container)
		}
		if strings.Contains(strings.Join(c.Argv, " "), "PRIVATE KEY") {
			t.Fatal("private key in argv")
		}
		if c.Argv[0] == "sh" || c.Argv[0] == "/bin/sh" {
			t.Fatalf("shell used: %v", c.Argv)
		}
	}
	reloadFails = false

	for _, bad := range [][3]string{
		{"../etc", "dkim", key}, {"panel.test", "a.b", key}, {"panel.test", "../x", key}, {"panel.test/x", "dkim", key},
		{"panel.test", "dkim", "not a key"}, {"panel.test", "dkim", key + "\njunk"}, {"panel", "dkim", key},
	} {
		if err := s.PutDKIM(ctx, bad[0], bad[1], bad[2]); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q/%q: %v", bad[0], bad[1], err)
		}
	}

	if err := s.DeleteDKIM(ctx, "panel.test"); err != nil {
		t.Fatal(err)
	}
	if _, ok := files[dir+"/panel.test.dkim.key"]; ok {
		t.Fatal("key not deleted")
	}
	if files[dir+"/panel.test.au.dkim.key"] != "OTHER DOMAIN" || strings.Contains(files[dir+"/selectors.map"], "panel.test dkim") {
		t.Fatalf("delete touched wrong domain or map not updated: %q", files[dir+"/selectors.map"])
	}
	if err := s.DeleteDKIM(ctx, "nothing.test"); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

func TestDKIMNotRunning(t *testing.T) {
	fd := NewFakeDocker()
	fd.Add(engine.ContainerSummary{ID: "r", Name: "panel-rspamd", Labels: mailLabels, State: "exited"})
	s := New(Config{Hostname: "mail.panel.test", EnvFile: "/nonexistent"}, fd, nil)
	if err := s.PutDKIM(context.Background(), "panel.test", "dkim", testKey(t)); !errors.Is(err, ErrNotRunning) {
		t.Fatal(err)
	}
}

func TestReload(t *testing.T) {
	s, fd := newTestService(t, "mail.panel.test")
	if err := s.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range fd.Calls() {
		got = append(got, c.Container+": "+strings.Join(c.Argv, " "))
	}
	want := []string{"panel-postfix: postfix reload", "panel-dovecot: doveadm reload", "panel-rspamd: rspamadm control reload"}
	if !slices.Equal(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestQuota(t *testing.T) {
	s, fd := newTestService(t, "mail.panel.test")
	fd.Handler = func(c string, argv []string, _ string) (string, string, int, bool) {
		if c != "panel-dovecot" || argv[0] != "doveadm" {
			return "", "", 0, false
		}
		switch argv[len(argv)-1] {
		case "a@panel.test":
			return `[{"root":"User quota","type":"STORAGE","value":"100","limit":"1024","percent":"9"},{"root":"User quota","type":"MESSAGE","value":"3","limit":"-","percent":"0"}]`, "", 0, true
		case "b@panel.test":
			return `[{"root":"User quota","type":"STORAGE","value":"5","limit":"-","percent":"0"}]`, "", 0, true
		}
		return "", "doveadm(c@panel.test): Error: User doesn't exist", 67, true
	}
	items, err := s.Quota(context.Background(), []string{"A@panel.test", "b@panel.test", "c@panel.test"})
	if err != nil {
		t.Fatal(err)
	}
	if items[0].Address != "a@panel.test" || items[0].UsedBytes != 100*1024 || items[0].LimitBytes == nil || *items[0].LimitBytes != 1024*1024 {
		t.Fatalf("a: %+v", items[0])
	}
	if items[1].UsedBytes != 5*1024 || items[1].LimitBytes != nil || items[1].Error != "" {
		t.Fatalf("b: %+v", items[1])
	}
	if items[2].Error != "unknown_user" {
		t.Fatalf("c: %+v", items[2])
	}
	for _, c := range fd.Calls() {
		if !slices.Equal(c.Argv[:5], []string{"doveadm", "-f", "json", "quota", "get"}) {
			t.Fatalf("%v", c.Argv)
		}
	}
	for _, bad := range []string{"-A", "a@b", "../x@panel.test", "a/b@panel.test", ".a@panel.test", "a..b@panel.test", "a@panel.test;x", "a@-x.test"} {
		if _, err := s.Quota(context.Background(), []string{bad}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
}

func TestDeleteMailboxData(t *testing.T) {
	s, fd := newTestService(t, "mail.panel.test")
	fd.Files["panel-dovecot"] = map[string]string{
		"/var/vmail/panel.test/a/cur/1": "x", "/var/vmail/panel.test/ab/cur/1": "y",
	}
	ctx := context.Background()
	for _, bad := range []string{"../../etc@panel.test", "a@..", "a/../../b@panel.test", "a@panel.test/../..", "*@panel.test", ".@panel.test", "@panel.test", "a@"} {
		if err := s.DeleteMailboxData(ctx, bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	if err := s.DeleteMailboxData(ctx, "A@Panel.Test"); err != nil {
		t.Fatal(err)
	}
	calls := fd.Calls()
	if len(calls) != 1 || !slices.Equal(calls[0].Argv, []string{"rm", "-rf", "--", "/var/vmail/panel.test/a"}) {
		t.Fatalf("%+v", calls)
	}
	if _, ok := fd.Files["panel-dovecot"]["/var/vmail/panel.test/ab/cur/1"]; !ok {
		t.Fatal("other mailbox removed")
	}
}

func writeRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	os.MkdirAll(filepath.Join(repo, "deploy"), 0o755)
	os.WriteFile(filepath.Join(repo, "deploy", "docker-compose.yml"), []byte("name: panel\n"), 0o644)
	os.WriteFile(filepath.Join(repo, "deploy", "docker-compose.npm.yml"), []byte("services: {}\n"), 0o644)
	return repo
}

func TestEnableDisable(t *testing.T) {
	repo := writeRepo(t)
	envFile := filepath.Join(t.TempDir(), "panel.env")
	var mu sync.Mutex
	var runs []string
	var envs [][]string
	runner := func(_ context.Context, env []string, args ...string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		line := strings.Join(args, " ")
		runs = append(runs, line)
		envs = append(envs, env)
		switch {
		case strings.Contains(line, "--profile mail config --services"):
			return "panel\npostgres\npostfix\ndovecot\nrspamd\n", nil
		case strings.HasSuffix(line, "config --services"):
			return "panel\npostgres\n", nil
		}
		return "", nil
	}
	fd := NewFakeDocker()
	s := New(Config{RepoDir: repo, EnvFile: envFile, HTTPMode: "npm"}, fd, nil)
	s.Compose = runner
	ctx := context.Background()
	if err := s.Enable(ctx); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("no hostname: %v", err)
	}
	if len(runs) != 0 {
		t.Fatal("compose ran without hostname")
	}
	// MAIL_HOSTNAME uit het env-bestand (zonder herstart van de daemon).
	os.WriteFile(envFile, []byte("# x\nMAIL_HOSTNAME=\"Mail.Panel.Test\"\n"), 0o600)
	if s.Hostname() != "mail.panel.test" {
		t.Fatalf("hostname %q", s.Hostname())
	}
	if err := s.Enable(ctx); err != nil {
		t.Fatal(err)
	}
	base := "compose --env-file " + envFile + " -f " + filepath.Join(repo, "deploy", "docker-compose.yml") + " -f " + filepath.Join(repo, "deploy", "docker-compose.npm.yml")
	if last := runs[len(runs)-1]; last != base+" --profile mail up -d dovecot postfix rspamd" {
		t.Fatalf("up: %s", last)
	}
	if !slices.Contains(envs[len(envs)-1], "PANEL_ENV_FILE="+envFile) {
		t.Fatalf("env %v", envs[len(envs)-1])
	}
	if err := s.Disable(ctx); err != nil {
		t.Fatal(err)
	}
	if last := runs[len(runs)-1]; last != base+" --profile mail stop dovecot postfix rspamd" {
		t.Fatalf("stop: %s", last)
	}
	// Zonder checkout: ErrNoCompose.
	s2 := New(Config{Hostname: "mail.panel.test", EnvFile: envFile}, fd, nil)
	if err := s2.Enable(ctx); !errors.Is(err, ErrNoCompose) {
		t.Fatalf("no repo: %v", err)
	}
}
