package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/mail"
)

func mailAPI(t *testing.T, hostname string) (http.Handler, *mail.FakeDocker) {
	t.Helper()
	a := New(Options{NodeToken: "tok"}, nil, nil, nil, func(context.Context) SystemInfo { return SystemInfo{} }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	fd := mail.NewFakeDocker()
	labels := map[string]string{"panel.managed": "true", "panel.instance": "main", "panel.role": "mail"}
	fd.Add(engine.ContainerSummary{ID: "pf", Name: "panel-postfix", Labels: labels, State: "running"})
	fd.Add(engine.ContainerSummary{ID: "dc", Name: "panel-dovecot", Labels: labels, State: "running"})
	fd.Add(engine.ContainerSummary{ID: "rs", Name: "panel-rspamd", Labels: labels, State: "exited"})
	fd.Handler = func(c string, argv []string, _ string) (string, string, int, bool) {
		switch argv[0] {
		case "postqueue":
			if argv[1] == "-j" {
				return `{"queue_name":"deferred","queue_id":"ABCDEF12","arrival_time":1700000000,"message_size":5,"sender":"a@panel.test","recipients":[{"address":"b@node1.test","delay_reason":"timeout"}]}` + "\n", "", 0, true
			}
		case "postsuper":
			return "", "postsuper: Deleted: 0 messages\n", 0, true
		case "doveadm":
			if argv[1] == "-f" {
				return `[{"type":"STORAGE","value":"1","limit":"2"}]`, "", 0, true
			}
		case "postconf":
			return "mail.panel.test\n", "", 0, true
		}
		return "", "", 0, false
	}
	s := mail.New(mail.Config{Hostname: hostname, EnvFile: filepath.Join(t.TempDir(), "none.env")}, fd, nil)
	s.Checks = mail.CheckEnv{
		Resolver:     emptyResolver{},
		DNSBL:        emptyResolver{},
		Dial:         func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("offline") },
		Listen:       func(string, string) (net.Listener, error) { return nil, errors.New("no") },
		NTP:          func(context.Context, string) (time.Duration, error) { return 0, nil },
		DetectIP:     func(context.Context, bool) (string, error) { return "", errors.New("offline") },
		Listeners:    func([]int) ([]mail.Listener, error) { return nil, nil },
		DiskFree:     func(string) (uint64, uint64, error) { return 100, 50, nil },
		LocalIPs:     func() []netip.Addr { return nil },
		InboundPorts: []int{1},
		CheckTimeout: 2 * time.Second,
	}
	a.SetMail(s)
	return a.Handler(), fd
}

type emptyResolver struct{}

func nx(n string) error                                                        { return &net.DNSError{Err: "no such host", Name: n, IsNotFound: true} }
func (emptyResolver) LookupMX(_ context.Context, n string) ([]*net.MX, error)  { return nil, nx(n) }
func (emptyResolver) LookupAddr(_ context.Context, n string) ([]string, error) { return nil, nx(n) }
func (emptyResolver) LookupIP(_ context.Context, _, n string) ([]net.IP, error) {
	return nil, nx(n)
}
func (emptyResolver) LookupHost(_ context.Context, n string) ([]string, error) { return nil, nx(n) }

func TestMailNotLocal(t *testing.T) {
	a := New(Options{NodeToken: "tok"}, nil, nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h := a.Handler()
	if w := do(h, "GET", "/api/mail/status", "", "tok"); w.Code != 404 || !strings.Contains(w.Body.String(), "not_local") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := do(h, "GET", "/api/mail/status", "", ""); w.Code != 401 {
		t.Fatalf("no token: %d", w.Code)
	}
}

func TestMailEndpoints(t *testing.T) {
	h, fd := mailAPI(t, "mail.panel.test")
	for _, ep := range [][2]string{{"POST", "/api/mail/checks"}, {"GET", "/api/mail/status"}, {"POST", "/api/mail/enable"},
		{"PUT", "/api/mail/dkim/panel.test"}, {"DELETE", "/api/mail/queue/ABCDEF12"}, {"DELETE", "/api/mail/mailboxes/a@panel.test/data"}} {
		if w := do(h, ep[0], ep[1], "{}", "wrong"); w.Code != 401 {
			t.Fatalf("%v: %d", ep, w.Code)
		}
	}

	w := do(h, "GET", "/api/mail/status", "", "tok")
	var st struct {
		Enabled    bool `json:"enabled"`
		Containers []struct {
			Name, State string
		} `json:"containers"`
		Queue map[string]int `json:"queue"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &st) != nil || !st.Enabled || len(st.Containers) != 3 || st.Queue["deferred"] != 1 {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}

	w = do(h, "GET", "/api/mail/queue", "", "tok")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"queue_id":"ABCDEF12"`) || !strings.Contains(w.Body.String(), `"recipients":["b@node1.test"]`) || !strings.Contains(w.Body.String(), `"arrival_time":"2023-11-14T22:13:20Z"`) {
		t.Fatalf("queue %d %s", w.Code, w.Body)
	}
	if w := do(h, "DELETE", "/api/mail/queue/ALL", "", "tok"); w.Code != 400 {
		t.Fatalf("ALL: %d", w.Code)
	}
	if w := do(h, "DELETE", "/api/mail/queue/ABCDEF12", "", "tok"); w.Code != 404 {
		t.Fatalf("missing: %d %s", w.Code, w.Body)
	}
	if w := do(h, "POST", "/api/mail/queue/flush", "", "tok"); w.Code != 204 {
		t.Fatalf("flush: %d", w.Code)
	}

	w = do(h, "POST", "/api/mail/mailboxes/quota", `{"addresses":["a@panel.test"]}`, "tok")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `{"address":"a@panel.test","used_bytes":1024,"limit_bytes":2048}`) {
		t.Fatalf("quota %d %s", w.Code, w.Body)
	}
	if w := do(h, "POST", "/api/mail/mailboxes/quota", `{"addresses":["../x"]}`, "tok"); w.Code != 400 {
		t.Fatalf("bad quota: %d", w.Code)
	}
	if w := do(h, "DELETE", "/api/mail/mailboxes/a@panel.test/data", "", "tok"); w.Code != 204 {
		t.Fatalf("delete data: %d %s", w.Code, w.Body)
	}
	if w := do(h, "DELETE", "/api/mail/mailboxes/..%2F..%2Fetc@panel.test/data", "", "tok"); w.Code != 400 {
		t.Fatalf("traversal: %d %s", w.Code, w.Body)
	}

	// Rspamd draait niet: 409 mail_not_running.
	w = do(h, "PUT", "/api/mail/dkim/panel.test", `{"selector":"dkim","private_key_pem":"x"}`, "tok")
	if w.Code != 400 {
		t.Fatalf("bad key first: %d %s", w.Code, w.Body)
	}
	w = do(h, "DELETE", "/api/mail/dkim/panel.test", "", "tok")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "mail_not_running") {
		t.Fatalf("dkim delete %d %s", w.Code, w.Body)
	}

	// Reload: postfix + dovecot draaien, rspamd niet.
	if w := do(h, "POST", "/api/mail/reload", "", "tok"); w.Code != 204 {
		t.Fatalf("reload %d %s", w.Code, w.Body)
	}
	var reloads []string
	for _, c := range fd.Calls() {
		if c.Argv[0] == "mail-reload" {
			reloads = append(reloads, c.Container+" "+strings.Join(c.Argv, " "))
		}
	}
	if strings.Join(reloads, ",") != "panel-postfix mail-reload,panel-dovecot mail-reload" {
		t.Fatalf("%v", reloads)
	}

	// Geen checkout: enable → 404 not_local.
	if w := do(h, "POST", "/api/mail/enable", "", "tok"); w.Code != 404 {
		t.Fatalf("enable %d %s", w.Code, w.Body)
	}

	w = do(h, "POST", "/api/mail/checks", `{"mail_hostname":"mail.panel.test","public_ipv4":"203.0.113.10","public_ipv6":null}`, "tok")
	var rep struct {
		CheckedAt string `json:"checked_at"`
		Checks    []struct {
			ID       string `json:"id"`
			OK       bool   `json:"ok"`
			Required bool   `json:"required"`
			Detail   string `json:"detail"`
		} `json:"checks"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &rep) != nil || len(rep.Checks) != 10 || rep.CheckedAt == "" {
		t.Fatalf("checks %d %s", w.Code, w.Body)
	}
	for _, c := range rep.Checks {
		if c.ID == "" || c.Detail == "" {
			t.Fatalf("empty check %+v", c)
		}
	}
	if w := do(h, "POST", "/api/mail/checks", `{"mail_hostname":"x y"}`, "tok"); w.Code != 400 {
		t.Fatalf("bad check req: %d", w.Code)
	}
}

func TestMailEnableNotConfigured(t *testing.T) {
	h, _ := mailAPI(t, "")
	w := do(h, "POST", "/api/mail/enable", "", "tok")
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"error":"mail_not_configured"`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}
