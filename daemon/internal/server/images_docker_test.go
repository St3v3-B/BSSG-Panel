package server

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/spec"
)

// TestRealDockerImageCheckNoChange haalt een kleine tag twee keer op en ziet geen wijziging.
// Containers krijgen panel.test=true en een eigen panel.instance en worden opgeruimd; er wordt
// geen image verwijderd. Overslaan met PANEL_SKIP_DOCKER_TESTS=1, zonder Docker of zonder netwerk.
func TestRealDockerImageCheckNoChange(t *testing.T) {
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
	const ref = "alpine:3.20"
	if _, err := eng.PullImage(ctx, ref); err != nil {
		t.Skip("image niet op te halen (geen netwerk?):", err)
	}
	instance := fmt.Sprintf("image-updates-%d-%d", os.Getpid(), time.Now().UnixNano()%1e6)
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatal(err)
	}
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
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := NewManager(Config{DataDir: t.TempDir(), Instance: instance, ExtraLabels: map[string]string{"panel.test": "true"}, StopTimeout: 5 * time.Second, DiskInterval: time.Hour, StatsInterval: time.Hour}, eng, nopRep{}, log)
	t.Cleanup(m.Close)
	pnl := &fakePanel{settings: panel.ImageSettings{DefaultPolicy: "auto", WindowStart: "00:00", WindowEnd: "00:00", Timezone: spec.Timezone}}
	m.EnableImageUpdates(pnl, ImageConfig{})
	// Eigen uuid per run: panel-site-<uuid> van een andere (gelijktijdige of afgebroken) run hoort niet bij deze instance.
	var rb [16]byte
	_, _ = rand.Read(rb[:])
	rb[6], rb[8] = rb[6]&0x0f|0x40, rb[8]&0x3f|0x80
	uuid := fmt.Sprintf("%x-%x-%x-%x-%x", rb[0:4], rb[4:6], rb[6:8], rb[8:10], rb[10:])
	s, _, err := m.Create(spec.ServerSpec{
		UUID: uuid, Type: "game", Image: ref, Startup: `echo "Done (0.1s)"; exec sleep 300`, Stop: spec.Stop{Type: "signal", Value: "SIGKILL"},
		ReadyPattern: `Done \(`, Environment: map[string]string{}, Limits: spec.Limits{MemoryMB: 64, DiskMB: 100},
		Install: spec.Install{Image: ref, Script: "true"}, SkipInstall: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Power("start"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "online", func() bool { return s.State() == StateOnline })
	m.CheckImages(ctx)
	m.CheckImages(ctx)
	st := m.ImageStatuses()[uuid]
	if st.UpdateAvailable || st.CurrentImageID == nil || st.LatestImageID == nil || *st.CurrentImageID != *st.LatestImageID {
		t.Fatalf("expected no change: %+v", st)
	}
	if len(m.TrackedImages()) != 0 {
		t.Fatalf("the image existed before; the daemon did not pull it: %v", m.TrackedImages())
	}
	if len(pnl.reports) != 2 || pnl.updateCount() != 0 {
		t.Fatalf("reports=%d updates=%d", len(pnl.reports), pnl.updateCount())
	}
}
