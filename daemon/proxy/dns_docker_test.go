package proxy

// Eigen Caddy-build (deploy/caddy/Dockerfile) met caddy-dns/cloudflare: Caddy
// accepteert de gegenereerde DNS-challenge-policy, en Status meldt de fout van de
// (staging-)CA met reden. Draait alleen met PANEL_CADDY_IMAGE=<image van die build>
// (bouwen duurt minuten). Geen echte Cloudflare-token: de CA weigert .test-namen al
// bij de bestelling, er gaat niets naar productie-ACME.

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestDockerCaddyDNSChallenge(t *testing.T) {
	image := os.Getenv("PANEL_CADDY_IMAGE")
	if image == "" {
		t.Skip("PANEL_CADDY_IMAGE niet gezet")
	}
	e := setupCaddyWith(t, image, "le-staging.caddy")
	ctx := context.Background()
	c := e.router()
	const tok = "NepCloudflareToken0123456789abcdefghijkl"
	if err := c.SetRoute(ctx, Route{Host: "*.wild.test", DNSChallenge: &DNSChallenge{Provider: "cloudflare", APIToken: tok},
		Upstream: Upstream{Container: e.siteCtr, Network: e.siteNet, Port: 80}}); err != nil {
		t.Fatalf("Caddy weigert de DNS-policy: %v", err)
	}
	var st RouteStatus
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		if st, err = c.Status(ctx, "*.wild.test"); err != nil {
			t.Fatal(err)
		}
		if st.SSL == SSLFailed {
			break
		}
		time.Sleep(time.Second)
	}
	if st.SSL != SSLFailed || st.Error == "" || strings.Contains(st.Error, tok) {
		logs, _ := exec.Command("docker", "logs", "--tail", "30", e.caddy).CombinedOutput()
		t.Fatalf("status = %+v\n%s", st, logs)
	}
	t.Logf("status: %s: %s", st.SSL, st.Error)
	if logs, _ := exec.Command("docker", "logs", e.caddy).CombinedOutput(); strings.Contains(string(logs), tok) {
		t.Error("token staat in Caddy's log")
	}
	if err := c.RemoveRoute(ctx, "*.wild.test"); err != nil {
		t.Fatal(err)
	}
}
