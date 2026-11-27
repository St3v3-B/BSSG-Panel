package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/spec"
)

type nopRep struct{}

func (nopRep) ReportStatus(string, string)        {}
func (nopRep) ReportInstall(string, bool, string) {}
func (nopRep) ReportEvent(string, panel.Event)    {}

type fakePanel struct {
	mu       sync.Mutex
	settings panel.ImageSettings
	reports  [][]panel.ImageStatus
	updates  []panel.ImageUpdateResult
}

func (p *fakePanel) ImageSettings(context.Context) (panel.ImageSettings, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.settings, nil
}
func (p *fakePanel) ReportImages(items []panel.ImageStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reports = append(p.reports, items)
}
func (p *fakePanel) ReportImageUpdate(_ string, r panel.ImageUpdateResult) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.updates = append(p.updates, r)
}
func (p *fakePanel) updateCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.updates)
}

type env struct {
	t   *testing.T
	eng *engine.Fake
	m   *Manager
	pnl *fakePanel
	now time.Time
}

const (
	uuidA = "11111111-1111-4111-8111-111111111111"
	uuidB = "22222222-2222-4222-8222-222222222222"
)

func newEnv(t *testing.T, policy string) *env {
	t.Helper()
	eng := engine.NewFake()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := NewManager(Config{DataDir: t.TempDir(), Instance: "unit", StopTimeout: 2 * time.Second, DiskInterval: time.Hour, StatsInterval: time.Hour}, eng, nopRep{}, log)
	t.Cleanup(m.Close)
	// 2026-11-27 is een vrijdag; 12:00 Amsterdam (UTC+1) = 11:00 UTC: buiten het venster.
	e := &env{t: t, eng: eng, m: m, pnl: &fakePanel{settings: panel.ImageSettings{DefaultPolicy: policy, WindowStart: "04:00", WindowEnd: "05:00", Timezone: "Europe/Amsterdam"}},
		now: time.Date(2026, 11, 27, 11, 0, 0, 0, time.UTC)}
	m.EnableImageUpdates(e.pnl, ImageConfig{Warn: 50 * time.Millisecond, Now: func() time.Time { return e.now }})
	return e
}

func (e *env) server(uuid, typ, image string, iu *spec.ImageUpdate) *Server {
	e.t.Helper()
	sp := spec.ServerSpec{
		UUID: uuid, Type: typ, Image: image, Startup: "run", Stop: spec.Stop{Type: "command", Value: "stop"},
		ReadyPattern: `Done \(`, Environment: map[string]string{}, Limits: spec.Limits{MemoryMB: 256, DiskMB: 100},
		Install: spec.Install{Image: "alpine:3.20", Script: "true"}, SkipInstall: true, ImageUpdate: iu,
	}
	if typ == "game" {
		sp.Allocations = []spec.Allocation{{IP: "127.0.0.1", Port: 25565, Primary: true}}
	} else {
		p := 80
		sp.HTTPPort = &p
	}
	s, _, err := e.m.Create(sp)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *env) start(s *Server) {
	e.t.Helper()
	if err := s.Power("start"); err != nil {
		e.t.Fatal(err)
	}
	waitUntil(e.t, "online", func() bool { return s.State() == StateOnline })
}

func waitUntil(t *testing.T, what string, fn func() bool) {
	t.Helper()
	dl := time.Now().Add(20 * time.Second)
	for !fn() {
		if time.Now().After(dl) {
			t.Fatalf("timeout: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (e *env) status(uuid string) panel.ImageStatus { return e.m.ImageStatuses()[uuid] }

func TestDigestChangeDetection(t *testing.T) {
	e := newEnv(t, "notify")
	s := e.server(uuidA, "game", "java:1", nil)
	e.start(s)
	e.m.CheckImages(context.Background())
	if st := e.status(uuidA); st.UpdateAvailable {
		t.Fatalf("no change expected: %+v", st)
	}
	e.eng.SetRemote("java:1", "sha256:new")
	e.m.CheckImages(context.Background())
	st := e.status(uuidA)
	if !st.UpdateAvailable || st.LatestImageID == nil || *st.LatestImageID != "sha256:new" || *st.CurrentImageID != "sha256:java:1" {
		t.Fatalf("update expected: %+v", st)
	}
	// Alleen verwezen tags worden opgehaald: java:1 en alpine:3.20 (install).
	if e.eng.PullCount("java:1") != 2 || e.eng.PullCount("alpine:3.20") != 2 {
		t.Fatalf("pull log: %v", e.eng.PullLog)
	}
	// notify: nooit automatisch toepassen, ook niet in het venster.
	e.now = time.Date(2026, 11, 27, 3, 30, 0, 0, time.UTC) // 04:30 Amsterdam
	e.m.ApplyImagesAt(e.now)
	time.Sleep(150 * time.Millisecond)
	e.m.ApplyImagesAt(e.now.Add(time.Second))
	if e.pnl.updateCount() != 0 || e.status(uuidA).UpdateAvailable == false {
		t.Fatal("notify must not apply")
	}
	if len(e.pnl.reports) == 0 {
		t.Fatal("no report to panel")
	}
}

func TestAutoAppliesOnlyInWindowWithWarning(t *testing.T) {
	e := newEnv(t, "auto")
	s := e.server(uuidA, "game", "java:1", nil)
	e.start(s)
	e.m.CheckImages(context.Background())
	e.eng.SetRemote("java:1", "sha256:new")
	e.m.CheckImages(context.Background()) // buiten het venster (12:00)
	e.m.ApplyImagesAt(e.now)
	time.Sleep(100 * time.Millisecond)
	if e.pnl.updateCount() != 0 {
		t.Fatal("applied outside the window")
	}
	// In het venster: eerst waarschuwing, daarna pas herstart.
	win := time.Date(2026, 11, 27, 3, 10, 0, 0, time.UTC)
	sub := NewSub()
	s.Subscribe(sub, nil)
	e.m.ApplyImagesAt(win)
	if e.pnl.updateCount() != 0 {
		t.Fatal("must wait for the warning period")
	}
	sawWarning := false
	for _, o := range sub.Drain() {
		if strings.Contains(string(o.Data), "daemon_message") && strings.Contains(string(o.Data), "restarts in") {
			sawWarning = true
		}
	}
	if !sawWarning {
		t.Fatal("no daemon_message warning before the restart")
	}
	time.Sleep(80 * time.Millisecond)
	e.m.ApplyImagesAt(win.Add(time.Second))
	waitUntil(t, "update reported", func() bool { return e.pnl.updateCount() == 1 })
	waitUntil(t, "online again", func() bool { return s.State() == StateOnline })
	r := e.pnl.updates[0]
	if !r.Successful || r.Mode != "auto" || *r.To != "sha256:new" {
		t.Fatalf("%+v", r)
	}
	if c := e.eng.Container(ContainerName(uuidA)); c == nil || c.ImageID != "sha256:new" {
		t.Fatal("container not recreated from the new image")
	}
	waitUntil(t, "status clean", func() bool { return !e.status(uuidA).UpdateAvailable })
}

func TestStoppedServerNoRestartNeeded(t *testing.T) {
	e := newEnv(t, "auto")
	s := e.server(uuidA, "game", "java:1", nil)
	e.start(s)
	if err := s.Power("stop"); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "offline", func() bool { return s.State() == StateOffline })
	e.m.CheckImages(context.Background())
	e.eng.SetRemote("java:1", "sha256:new")
	e.m.CheckImages(context.Background())
	if e.status(uuidA).UpdateAvailable {
		t.Fatal("a stopped server picks up the image on its next start; no update pending")
	}
	e.start(s)
	if c := e.eng.Container(ContainerName(uuidA)); c.ImageID != "sha256:new" {
		t.Fatalf("start used %s", c.ImageID)
	}
}

func TestPolicyOffAndOverride(t *testing.T) {
	e := newEnv(t, "auto") // globaal auto
	e.m.img.refreshSettingsForce(context.Background())
	off := e.server(uuidA, "game", "java:1", &spec.ImageUpdate{Policy: "off"})
	def := e.server(uuidB, "game", "java:2", &spec.ImageUpdate{Policy: "default"})
	if p := e.m.img.policyOf(off.Spec()); p != "off" {
		t.Fatal(p)
	}
	if p := e.m.img.policyOf(def.Spec()); p != "auto" {
		t.Fatal(p)
	}
}

func TestWindow(t *testing.T) {
	ams := func(h, m int) time.Time { // 2026-11-27 is winter: UTC+1
		return time.Date(2026, 11, 27, h-1, m, 0, 0, time.UTC)
	}
	cases := []struct {
		start, end string
		h, m       int
		want       bool
	}{
		{"04:00", "05:00", 4, 0, true}, {"04:00", "05:00", 4, 59, true}, {"04:00", "05:00", 5, 0, false}, {"04:00", "05:00", 3, 59, false},
		{"23:00", "02:00", 23, 30, true}, {"23:00", "02:00", 1, 59, true}, {"23:00", "02:00", 2, 0, false}, {"23:00", "02:00", 12, 0, false},
		{"00:00", "00:00", 13, 0, true}, {"xx", "05:00", 4, 0, false},
	}
	for _, c := range cases {
		if got := InWindow(ams(c.h, c.m), c.start, c.end, "Europe/Amsterdam"); got != c.want {
			t.Errorf("%s-%s at %02d:%02d: got %v", c.start, c.end, c.h, c.m, got)
		}
	}
	// zomertijd: 04:30 Amsterdam = 02:30 UTC
	if !InWindow(time.Date(2026, 7, 1, 2, 30, 0, 0, time.UTC), "04:00", "05:00", "Europe/Amsterdam") {
		t.Error("summer time")
	}
}

func TestPHPMinorRequiresReinstall(t *testing.T) {
	e := newEnv(t, "auto")
	ve := "PHP_VERSION"
	s := e.server(uuidA, "web", "php:8.3", &spec.ImageUpdate{Policy: "auto", VersionEnv: &ve})
	e.eng.SetRemote("php:8.3", "sha256:old")
	e.eng.SetImageEnv("sha256:old", []string{"PATH=/x", "PHP_VERSION=8.3.14"})
	e.start(s)
	// Patch-update: automatisch toepasbaar.
	e.eng.SetRemote("php:8.3", "sha256:patch")
	e.eng.SetImageEnv("sha256:patch", []string{"PHP_VERSION=8.3.15"})
	e.m.CheckImages(context.Background())
	st := e.status(uuidA)
	if !st.UpdateAvailable || st.ReinstallRequired {
		t.Fatalf("patch: %+v", st)
	}
	// Minor-sprong: alleen melden.
	e.eng.SetRemote("php:8.3", "sha256:minor")
	e.eng.SetImageEnv("sha256:minor", []string{"PHP_VERSION=8.4.1"})
	e.m.CheckImages(context.Background())
	st = e.status(uuidA)
	if !st.UpdateAvailable || !st.ReinstallRequired {
		t.Fatalf("minor: %+v", st)
	}
	e.now = time.Date(2026, 11, 27, 3, 10, 0, 0, time.UTC)
	e.m.ApplyImagesAt(e.now)
	e.m.ApplyImagesAt(e.now.Add(time.Second))
	time.Sleep(100 * time.Millisecond)
	if e.pnl.updateCount() != 0 {
		t.Fatal("must not auto-apply when a reinstall is needed")
	}
	for in, want := range map[string]string{"8.3.14": "8.3", "v8.4": "8.4", "8": ""} {
		if got, _ := MajorMinor(in); got != want {
			t.Errorf("MajorMinor(%q) = %q", in, got)
		}
	}
}

func TestWebAutoRestartIsImmediateInWindow(t *testing.T) {
	e := newEnv(t, "auto")
	s := e.server(uuidA, "web", "nginx:1", nil)
	e.start(s)
	e.eng.SetRemote("nginx:1", "sha256:n2")
	e.m.CheckImages(context.Background())
	win := time.Date(2026, 11, 27, 3, 10, 0, 0, time.UTC)
	e.m.ApplyImagesAt(win)
	waitUntil(t, "update reported", func() bool { return e.pnl.updateCount() == 1 })
	waitUntil(t, "online", func() bool { return s.State() == StateOnline })
}

func TestManualUpdateNow(t *testing.T) {
	e := newEnv(t, "notify")
	s := e.server(uuidA, "game", "java:1", nil)
	e.start(s)
	e.eng.SetRemote("java:1", "sha256:new")
	if err := e.m.UpdateImageNow(uuidA); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "reported", func() bool { return e.pnl.updateCount() == 1 })
	if r := e.pnl.updates[0]; !r.Successful || r.Mode != "manual" {
		t.Fatalf("%+v", r)
	}
	waitUntil(t, "online", func() bool { return s.State() == StateOnline })
	if c := e.eng.Container(ContainerName(uuidA)); c.ImageID != "sha256:new" {
		t.Fatal("old image")
	}
	if !errors.Is(e.m.UpdateImageNow("33333333-3333-4333-8333-333333333333"), ErrNotFound) {
		t.Fatal("unknown server")
	}
}

func TestPullFailureKeepsRunning(t *testing.T) {
	e := newEnv(t, "auto")
	s := e.server(uuidA, "game", "java:1", nil)
	e.start(s)
	e.eng.FailPull = errors.New("registry down")
	e.m.CheckImages(context.Background())
	if e.status(uuidA).UpdateAvailable || s.State() != StateOnline {
		t.Fatal("a failed pull changes nothing")
	}
}

func TestCleanupOnlyTrackedUnusedImages(t *testing.T) {
	e := newEnv(t, "notify")
	// Andermans image (niet door de daemon opgehaald), ook ongebruikt: nooit aanraken.
	e.eng.AddLocalImage("ntp-pool:latest", "sha256:ntp")
	// Een image van de gebruiker die dezelfde tag heeft als onze server (bestond al) en niet verandert.
	e.eng.AddLocalImage("java:1", "sha256:java:1")
	s := e.server(uuidA, "game", "java:1", nil)
	e.start(s)
	e.m.CheckImages(context.Background())
	if len(e.m.TrackedImages()) != 1 { // alleen alpine (install-image, door ons opgehaald)
		t.Fatalf("tracked: %v", e.m.TrackedImages())
	}
	// Nieuwe build van java:1: nieuw id wordt gevolgd, het oude (van de gebruiker) niet.
	e.eng.SetRemote("java:1", "sha256:j2")
	e.m.CheckImages(context.Background())
	if _, ok := e.m.TrackedImages()["sha256:j2"]; !ok {
		t.Fatalf("new image not tracked: %v", e.m.TrackedImages())
	}
	if _, ok := e.m.TrackedImages()["sha256:java:1"]; ok {
		t.Fatal("pre-existing image must not be tracked")
	}
	// Server herstart op j2; een tweede build j3 maakt j2 ongebruikt.
	if err := e.m.UpdateImageNow(uuidA); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "restarted", func() bool {
		c := e.eng.Container(ContainerName(uuidA))
		return c != nil && c.ImageID == "sha256:j2" && s.State() == StateOnline
	})
	e.eng.SetRemote("java:1", "sha256:j3")
	e.m.CheckImages(context.Background())
	if !e.eng.HasImage("sha256:j2") {
		t.Fatal("j2 is still used by the running container")
	}
	if err := e.m.UpdateImageNow(uuidA); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "restarted on j3", func() bool {
		c := e.eng.Container(ContainerName(uuidA))
		return c != nil && c.ImageID == "sha256:j3" && s.State() == StateOnline
	})
	e.m.CheckImages(context.Background())
	if e.eng.HasImage("sha256:j2") {
		t.Fatal("unused tracked image must be removed")
	}
	if !e.eng.HasImage("sha256:j3") || !e.eng.HasImage("sha256:ntp") || !e.eng.HasImage("sha256:java:1") {
		t.Fatal("current and foreign images must stay")
	}
}

func TestSpecUpdateKeepsPolicy(t *testing.T) {
	e := newEnv(t, "notify")
	s := e.server(uuidA, "game", "java:1", &spec.ImageUpdate{Policy: "auto"})
	sp := s.Spec()
	sp.ImageUpdate = nil
	if err := s.Update(sp); err != nil || s.Spec().ImageUpdate == nil || s.Spec().ImageUpdate.Policy != "auto" {
		t.Fatalf("%v %+v", err, s.Spec().ImageUpdate)
	}
	ve := "PHP_VERSION"
	sp.ImageUpdate = &spec.ImageUpdate{VersionEnv: &ve}
	if err := s.Update(sp); err != nil || s.Spec().ImageUpdate.Policy != "auto" || *s.Spec().ImageUpdate.VersionEnv != ve {
		t.Fatalf("%+v", s.Spec().ImageUpdate)
	}
	sp.ImageUpdate = &spec.ImageUpdate{Policy: "default"}
	_ = s.Update(sp)
	if s.Spec().ImageUpdate.Policy != "default" {
		t.Fatal("explicit default must apply")
	}
}
