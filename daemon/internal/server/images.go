package server

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"panel/daemon/internal/engine"
	"panel/daemon/internal/panel"
	"panel/daemon/internal/spec"
	"panel/daemon/internal/store"
)

// DefaultImageSettings gelden zolang het panel niet bereikbaar is geweest.
var DefaultImageSettings = panel.ImageSettings{DefaultPolicy: "notify", WindowStart: "04:00", WindowEnd: "05:00", Timezone: spec.Timezone}

// ImagePanel is wat de image-updater van het panel nodig heeft (panel.Client implementeert dit).
type ImagePanel interface {
	ImageSettings(ctx context.Context) (panel.ImageSettings, error)
	ReportImages(items []panel.ImageStatus)
	ReportImageUpdate(uuid string, r panel.ImageUpdateResult)
}

// ImageConfig stelt de image-updater af.
type ImageConfig struct {
	// Interval tussen controles (0 = geen automatische controles; handmatig kan altijd).
	Interval time.Duration
	// InitialDelay voor de eerste controle na de start (standaard 2 min).
	InitialDelay time.Duration
	// Tick: hoe vaak beleid toegepast wordt (standaard 30 s).
	Tick time.Duration
	// Warn: wachttijd tussen de console-waarschuwing en de herstart (standaard 1 min).
	Warn time.Duration
	// Now vervangt time.Now (tests).
	Now func() time.Time
}

type imageState struct {
	LastCheck time.Time         `json:"last_check"`
	Tracked   map[string]string `json:"tracked"` // image-id → ref: door de daemon opgehaald
}

type imageUpdater struct {
	m   *Manager
	pnl ImagePanel
	cfg ImageConfig

	checking sync.Mutex // één controle tegelijk

	mu       sync.Mutex
	settings panel.ImageSettings
	setAt    time.Time
	state    imageState
	status   map[string]panel.ImageStatus
	due      map[string]time.Time // uuid → moment van de herstart (na de waarschuwing)
	busy     map[string]bool      // uuid → een update loopt
}

// EnableImageUpdates zet de periodieke controle aan. Aanroepen vóór Recover/Start.
func (m *Manager) EnableImageUpdates(p ImagePanel, cfg ImageConfig) {
	if cfg.InitialDelay == 0 {
		cfg.InitialDelay = 2 * time.Minute
	}
	if cfg.Tick == 0 {
		cfg.Tick = 30 * time.Second
	}
	if cfg.Warn == 0 {
		cfg.Warn = time.Minute
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	u := &imageUpdater{m: m, pnl: p, cfg: cfg, settings: DefaultImageSettings, status: map[string]panel.ImageStatus{}, due: map[string]time.Time{}, busy: map[string]bool{}}
	_ = store.ReadJSON(u.statePath(), &u.state)
	if u.state.Tracked == nil {
		u.state.Tracked = map[string]string{}
	}
	m.img = u
}

// StartImageUpdates start de achtergrondlus (na Recover).
func (m *Manager) StartImageUpdates() {
	if m.img != nil {
		go m.img.loop()
	}
}

// ImageStatuses geeft de laatste status per server (voor tests).
func (m *Manager) ImageStatuses() map[string]panel.ImageStatus {
	if m.img == nil {
		return nil
	}
	m.img.mu.Lock()
	defer m.img.mu.Unlock()
	out := make(map[string]panel.ImageStatus, len(m.img.status))
	for k, v := range m.img.status {
		out[k] = v
	}
	return out
}

// CheckImages doet nu een controle (synchroon).
func (m *Manager) CheckImages(ctx context.Context) {
	if m.img != nil {
		m.img.check(ctx)
	}
}

// ApplyImagesAt past `auto`-beleid nu toe voor het opgegeven moment (tests: tick).
func (m *Manager) ApplyImagesAt(now time.Time) {
	if m.img != nil {
		m.img.apply(now)
	}
}

// TrackedImages geeft image-id → ref van de images die de daemon zelf ophaalde (voor tests).
func (m *Manager) TrackedImages() map[string]string {
	if m.img == nil {
		return nil
	}
	m.img.mu.Lock()
	defer m.img.mu.Unlock()
	out := map[string]string{}
	for k, v := range m.img.state.Tracked {
		out[k] = v
	}
	return out
}

// ensureImage haalt ref op als hij lokaal ontbreekt en onthoudt dat de daemon hem ophaalde.
func (m *Manager) ensureImage(ctx context.Context, ref string, progress func(string)) error {
	_, had := m.eng.ImageID(ctx, ref)
	if err := m.eng.EnsureImage(ctx, ref, progress); err != nil {
		return err
	}
	if had != nil && m.img != nil {
		if id, err := m.eng.ImageID(ctx, ref); err == nil {
			m.img.track(id, ref)
		}
	}
	return nil
}

func (u *imageUpdater) statePath() string {
	return filepath.Join(u.m.cfg.DataDir, "state", "images.json")
}

func (u *imageUpdater) saveLocked() {
	if err := store.WriteJSON(u.statePath(), u.state); err != nil {
		u.m.log.Warn("saving image state failed", "err", err)
	}
}

func (u *imageUpdater) track(id, ref string) {
	if id == "" {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if _, ok := u.state.Tracked[id]; !ok {
		u.state.Tracked[id] = ref
		u.saveLocked()
	}
}

func (u *imageUpdater) loop() {
	t := time.NewTicker(u.cfg.Tick)
	defer t.Stop()
	u.mu.Lock()
	next := u.state.LastCheck.Add(u.cfg.Interval)
	if first := u.cfg.Now().Add(u.cfg.InitialDelay); u.state.LastCheck.IsZero() || next.Before(first) {
		next = first
	}
	u.mu.Unlock()
	for {
		select {
		case <-u.m.ctx.Done():
			return
		case <-t.C:
			now := u.cfg.Now()
			if u.cfg.Interval > 0 && !now.Before(next) {
				u.check(u.m.ctx)
				next = u.cfg.Now().Add(u.cfg.Interval)
			}
			u.apply(u.cfg.Now())
		}
	}
}

func (u *imageUpdater) refreshSettings(ctx context.Context) panel.ImageSettings {
	u.mu.Lock()
	cur, at := u.settings, u.setAt
	u.mu.Unlock()
	if !at.IsZero() && u.cfg.Now().Sub(at) < time.Hour {
		return cur
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	s, err := u.pnl.ImageSettings(cctx)
	if err != nil {
		u.m.log.Debug("fetching image-update settings failed", "err", err)
		return cur
	}
	if s.Timezone == "" {
		s.Timezone = spec.Timezone
	}
	u.mu.Lock()
	u.settings, u.setAt = s, u.cfg.Now()
	u.mu.Unlock()
	return s
}

// refs verzamelt alle images van servers: runtime en install.
func (u *imageUpdater) refs() (all map[string]bool) {
	all = map[string]bool{}
	for _, s := range u.m.List() {
		sp := s.Spec()
		if sp.Image != "" {
			all[sp.Image] = true
		}
		if sp.Install.Image != "" {
			all[sp.Install.Image] = true
		}
	}
	return all
}

// check haalt alle images van deze node op, rapporteert en past beleid toe.
func (u *imageUpdater) check(ctx context.Context) {
	if !u.checking.TryLock() {
		return
	}
	defer u.checking.Unlock()
	u.refreshSettingsForce(ctx)
	eng := u.m.eng
	for ref := range u.refs() {
		before, errBefore := eng.ImageID(ctx, ref)
		id, err := eng.PullImage(ctx, ref)
		if err != nil {
			u.m.log.Warn("pulling image failed", "image", ref, "err", err)
			continue
		}
		if errBefore != nil || id != before {
			u.track(id, ref) // de daemon haalde dit id op
		}
	}
	u.mu.Lock()
	u.state.LastCheck = u.cfg.Now()
	u.saveLocked()
	u.mu.Unlock()
	u.reportAll(ctx)
	u.cleanup(ctx)
	u.apply(u.cfg.Now())
}

func (u *imageUpdater) refreshSettingsForce(ctx context.Context) {
	u.mu.Lock()
	u.setAt = time.Time{}
	u.mu.Unlock()
	u.refreshSettings(ctx)
}

var versionRe = regexp.MustCompile(`^v?(\d+)\.(\d+)`)

// MajorMinor haalt "8.3" uit een waarde als "8.3.14".
func MajorMinor(v string) (string, bool) {
	m := versionRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return "", false
	}
	return m[1] + "." + m[2], true
}

func envValue(env []string, key string) (string, bool) {
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok && k == key {
			return v, true
		}
	}
	return "", false
}

// reinstallNeeded: de versie-variabele (major.minor) verschilt tussen de oude en nieuwe image.
func (u *imageUpdater) reinstallNeeded(ctx context.Context, sp spec.ServerSpec, curID, newID string) bool {
	if sp.ImageUpdate == nil || sp.ImageUpdate.VersionEnv == nil || *sp.ImageUpdate.VersionEnv == "" {
		return false
	}
	key := *sp.ImageUpdate.VersionEnv
	oldEnv, err1 := u.m.eng.ImageEnv(ctx, curID)
	newEnv, err2 := u.m.eng.ImageEnv(ctx, newID)
	if err1 != nil || err2 != nil {
		return false
	}
	ov, ok1 := envValue(oldEnv, key)
	nv, ok2 := envValue(newEnv, key)
	if !ok1 || !ok2 {
		return false
	}
	om, ok1 := MajorMinor(ov)
	nm, ok2 := MajorMinor(nv)
	return ok1 && ok2 && om != nm
}

// runningImageID geeft het image-id van de draaiende container ("" als er geen draait).
func (s *Server) runningImageID(ctx context.Context) string {
	s.mu.Lock()
	r := s.run
	s.mu.Unlock()
	if r == nil {
		return ""
	}
	c, err := s.m.eng.Inspect(ctx, r.id)
	if err != nil {
		return ""
	}
	return c.ImageID
}

func (u *imageUpdater) statusOf(ctx context.Context, s *Server) panel.ImageStatus {
	sp := s.Spec()
	st := panel.ImageStatus{UUID: sp.UUID, Image: sp.Image, CheckedAt: u.cfg.Now().UTC()}
	cur := s.runningImageID(ctx)
	latest, err := u.m.eng.ImageID(ctx, sp.Image)
	if err != nil {
		latest = ""
	}
	if cur != "" {
		st.CurrentImageID = &cur
	}
	if latest != "" {
		st.LatestImageID = &latest
	}
	if cur != "" && latest != "" && cur != latest {
		st.UpdateAvailable = true
		st.ReinstallRequired = u.reinstallNeeded(ctx, sp, cur, latest)
	}
	return st
}

func (u *imageUpdater) reportAll(ctx context.Context) {
	var items []panel.ImageStatus
	u.mu.Lock()
	u.status = map[string]panel.ImageStatus{}
	u.mu.Unlock()
	for _, s := range u.m.List() {
		st := u.statusOf(ctx, s)
		items = append(items, st)
		u.mu.Lock()
		u.status[st.UUID] = st
		u.mu.Unlock()
	}
	u.pnl.ReportImages(items)
}

func (u *imageUpdater) reportOne(ctx context.Context, s *Server) {
	st := u.statusOf(ctx, s)
	u.mu.Lock()
	u.status[st.UUID] = st
	u.mu.Unlock()
	u.pnl.ReportImages([]panel.ImageStatus{st})
}

// cleanup verwijdert images die de daemon ophaalde en die nergens meer voor nodig zijn.
func (u *imageUpdater) cleanup(ctx context.Context) {
	eng := u.m.eng
	current := map[string]bool{}
	for ref := range u.refs() {
		if id, err := eng.ImageID(ctx, ref); err == nil {
			current[id] = true
		}
	}
	u.mu.Lock()
	tracked := make(map[string]string, len(u.state.Tracked))
	for k, v := range u.state.Tracked {
		tracked[k] = v
	}
	u.mu.Unlock()
	for id, ref := range tracked {
		if current[id] {
			continue
		}
		used, err := eng.ImageUsed(ctx, id)
		if err != nil || used {
			continue
		}
		err = eng.RemoveImage(ctx, id)
		if err != nil && !errors.Is(err, engine.ErrNotFound) {
			u.m.log.Debug("old image not removed", "image", ref, "id", id, "err", err)
			continue
		}
		u.m.log.Info("old image removed", "image", ref, "id", id)
		u.mu.Lock()
		delete(u.state.Tracked, id)
		u.saveLocked()
		u.mu.Unlock()
	}
}

// ---------- beleid ----------

func (u *imageUpdater) policyOf(sp spec.ServerSpec) string {
	if sp.ImageUpdate != nil {
		switch sp.ImageUpdate.Policy {
		case "auto", "notify", "off":
			return sp.ImageUpdate.Policy
		}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.settings.DefaultPolicy
}

func parseClock(s string) (int, bool) {
	h, m, ok := strings.Cut(s, ":")
	if !ok {
		return 0, false
	}
	hh, e1 := strconv.Atoi(h)
	mm, e2 := strconv.Atoi(m)
	if e1 != nil || e2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, false
	}
	return hh*60 + mm, true
}

// InWindow meldt of t binnen het onderhoudsvenster valt (venster mag over middernacht
// lopen; begin == einde betekent altijd).
func InWindow(t time.Time, start, end, tz string) bool {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	a, ok1 := parseClock(start)
	b, ok2 := parseClock(end)
	if !ok1 || !ok2 {
		return false
	}
	t = t.In(loc)
	n := t.Hour()*60 + t.Minute()
	switch {
	case a == b:
		return true
	case a < b:
		return n >= a && n < b
	default:
		return n >= a || n < b
	}
}

// apply past het `auto`-beleid toe op servers waarvoor een update beschikbaar is.
func (u *imageUpdater) apply(now time.Time) {
	u.mu.Lock()
	set := u.settings
	u.mu.Unlock()
	inWin := InWindow(now, set.WindowStart, set.WindowEnd, set.Timezone)
	for _, s := range u.m.List() {
		sp := s.Spec()
		u.mu.Lock()
		st, ok := u.status[sp.UUID]
		due, pending := u.due[sp.UUID]
		busy := u.busy[sp.UUID]
		u.mu.Unlock()
		if busy {
			continue
		}
		if !ok || !st.UpdateAvailable || st.ReinstallRequired || u.policyOf(sp) != "auto" || s.State() == StateInstalling {
			if pending {
				u.mu.Lock()
				delete(u.due, sp.UUID)
				u.mu.Unlock()
			}
			continue
		}
		if !pending {
			if !inWin {
				continue
			}
			wait := u.cfg.Warn
			if sp.Type == "web" {
				wait = 0 // sites hebben geen console-kijkers; de pull is al gedaan, dus kort uit
			} else {
				s.DaemonMessage("warning", fmt.Sprintf("A new image is available. The server restarts in %s to update.", wait.Round(time.Second)))
			}
			due = now.Add(wait)
			u.mu.Lock()
			u.due[sp.UUID] = due
			u.mu.Unlock()
		}
		if now.Before(due) {
			continue
		}
		u.mu.Lock()
		delete(u.due, sp.UUID)
		u.mu.Unlock()
		go u.recreate(s, "auto", false)
	}
}

// recreate maakt de container opnieuw aan met de lokale image. Bij manual wordt eerst opgehaald.
// Een niet-draaiende server wordt niet gestart: de volgende start gebruikt de nieuwe image.
func (u *imageUpdater) recreate(s *Server, mode string, pull bool) {
	ctx := s.ctx
	sp := s.Spec()
	u.mu.Lock()
	if u.busy[sp.UUID] {
		u.mu.Unlock()
		return
	}
	u.busy[sp.UUID] = true
	u.mu.Unlock()
	res := panel.ImageUpdateResult{Mode: mode}
	finish := func(err error) {
		defer func() {
			u.mu.Lock()
			delete(u.busy, sp.UUID)
			u.mu.Unlock()
		}()
		if err != nil {
			msg := err.Error()
			res.Error = &msg
			s.DaemonMessage("error", "image update failed: "+msg)
		}
		res.Successful = err == nil
		u.pnl.ReportImageUpdate(sp.UUID, res)
		u.reportOne(context.Background(), s)
	}
	if pull {
		before, errBefore := u.m.eng.ImageID(ctx, sp.Image)
		id, err := u.m.eng.PullImage(ctx, sp.Image)
		if err != nil {
			finish(fmt.Errorf("pulling %s: %w", sp.Image, err))
			return
		}
		if errBefore != nil || id != before {
			u.track(id, sp.Image)
		}
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	cur := s.runningImageID(ctx)
	if cur != "" {
		res.From = &cur
	}
	latest, _ := u.m.eng.ImageID(ctx, sp.Image)
	if latest != "" {
		res.To = &latest
	}
	if cur == "" { // staat uit of slaapt: de volgende start gebruikt de nieuwe image
		finish(nil)
		return
	}
	if cur == latest {
		finish(nil)
		return
	}
	s.DaemonMessage("warning", "Restarting to apply the new image.")
	if err := s.doStop(false); err != nil {
		finish(err)
		return
	}
	finish(s.doStart())
}

// UpdateImageNow haalt de image van de server op en herstart hem als hij draait (asynchroon).
func (m *Manager) UpdateImageNow(uuid string) error {
	s, ok := m.Get(uuid)
	if !ok {
		return ErrNotFound
	}
	if m.img == nil {
		return errors.New("image updates are not enabled")
	}
	if st := s.State(); st == StateInstalling || st == StateInstallFailed {
		return &StateError{st, "not possible during installation"}
	}
	go m.img.recreate(s, "manual", true)
	return nil
}
