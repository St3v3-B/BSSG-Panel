package panel_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"panel/daemon/internal/panel"
	"panel/daemon/internal/testpanel"
)

func client(p *testpanel.Panel, token string) *panel.Client {
	c := panel.New(p.URL, token, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.MinBackoff, c.MaxBackoff = 5*time.Millisecond, 20*time.Millisecond
	c.MaxRetry = 2 * time.Second
	return c
}

const uuid = "0b7c2d1e-1111-4222-8333-444455556666"

func TestReportsWithRetry(t *testing.T) {
	p := testpanel.New("tok", "node1.test")
	defer p.Close()
	p.FailNext = 2
	c := client(p, "tok")
	c.ReportInstall(uuid, false, "kapot")
	c.Wait()
	calls := p.Calls("/api/remote/servers/" + uuid + "/install")
	if len(calls) != 1 || calls[0].Body["successful"] != false || calls[0].Body["error"] != "kapot" {
		t.Fatalf("%+v", calls)
	}
	c.Hello("1.0", "soft", false)
	c.Wait()
	h := p.Calls("/api/remote/node/hello")
	if len(h) != 1 || h[0].Body["version"] != "1.0" || h[0].Body["disk_quota_mode"] != "soft" {
		t.Fatalf("%+v", h)
	}
	c.ReportInstall(uuid, true, "")
	c.Wait()
	calls = p.Calls("/api/remote/servers/" + uuid + "/install")
	if calls[1].Body["error"] != nil || calls[1].Body["successful"] != true {
		t.Fatalf("%+v", calls[1])
	}
}

func TestNoRetryOn4xx(t *testing.T) {
	p := testpanel.New("tok", "node1.test")
	defer p.Close()
	c := client(p, "verkeerd")
	start := time.Now()
	c.ReportStatus(uuid, "online")
	c.Wait()
	if time.Since(start) > time.Second {
		t.Fatal("4xx werd herhaald")
	}
	if _, err := c.JWKS(context.Background()); err == nil {
		t.Fatal("JWKS met verkeerd token")
	}
}

func TestStatusOrderAndCoalesce(t *testing.T) {
	p := testpanel.New("tok", "node1.test")
	defer p.Close()
	c := client(p, "tok")
	for _, s := range []string{"starting", "online", "stopping", "offline"} {
		c.ReportStatus(uuid, s)
	}
	c.Wait()
	got := p.Statuses(uuid)
	if len(got) == 0 || got[len(got)-1] != "offline" {
		t.Fatalf("laatste status moet offline zijn: %v", got)
	}
}
