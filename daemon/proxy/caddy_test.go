package proxy

import (
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeAdmin is een minimale Caddy admin-API: alleen de routes van één server,
// met ETag/If-Match zoals Caddy.
type fakeAdmin struct {
	mu       sync.Mutex
	routes   []any
	patches  int
	fail412  int // zoveel PATCHes eerst met 412 weigeren
	down     bool
	srv      *httptest.Server
	basePath string
}

func fixedRoutes() []any {
	var r []any
	_ = json.Unmarshal([]byte(`[
	 {"match":[{"host":["panel.test"]}],"handle":[{"handler":"subroute","routes":[{"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"panel:3000"}]}]}]}],"terminal":true},
	 {"match":[{"host":["node1.test"]}],"handle":[{"handler":"subroute","routes":[{"handle":[{"flush_interval":-1,"handler":"reverse_proxy","upstreams":[{"dial":"unix//run/panel/daemon.sock"}]}]}]}],"terminal":true}
	]`), &r)
	return r
}

func newFakeAdmin(t *testing.T) *fakeAdmin {
	f := &fakeAdmin{routes: fixedRoutes(), basePath: "/config/apps/http/servers/panel/routes"}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAdmin) etag() string {
	b, _ := json.Marshal(f.routes)
	return fmt.Sprintf(`"%s %x"`, f.basePath, sha256.Sum256(b))
}

func (f *fakeAdmin) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		http.Error(w, "down", http.StatusServiceUnavailable)
		return
	}
	if r.URL.Path != f.basePath {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Etag", f.etag())
		_ = json.NewEncoder(w).Encode(f.routes)
	case http.MethodPatch:
		if f.fail412 > 0 {
			f.fail412--
			http.Error(w, "precondition", http.StatusPreconditionFailed)
			return
		}
		if im := r.Header.Get("If-Match"); im != f.etag() {
			http.Error(w, "etag mismatch: "+im, http.StatusPreconditionFailed)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var next []any
		if err := json.Unmarshal(b, &next); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.routes = next
		f.patches++
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (f *fakeAdmin) snapshot() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]map[string]any, len(f.routes))
	for i, r := range f.routes {
		out[i] = r.(map[string]any)
	}
	return out
}

func (f *fakeAdmin) ids() []string {
	var out []string
	for _, r := range f.snapshot() {
		id, _ := r["@id"].(string)
		out = append(out, id)
	}
	return out
}

func (f *fakeAdmin) find(id string) map[string]any {
	for _, r := range f.snapshot() {
		if r["@id"] == id {
			return r
		}
	}
	return nil
}

func newTestCaddy(t *testing.T, f *fakeAdmin, opt CaddyOptions) *Caddy {
	t.Helper()
	cfg := Config{AdminURL: f.srv.URL, Instance: "t1"}
	if opt.Docker != nil {
		cfg.CaddyContainer = "caddy-t1"
	}
	c, err := NewCaddyWithOptions(cfg, opt)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestNewCaddyImplementsHealthChecker(t *testing.T) {
	r, err := NewCaddy(Config{AdminURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.(HealthChecker); !ok {
		t.Fatal("NewCaddy moet HealthChecker implementeren")
	}
	if _, err := NewCaddy(Config{AdminURL: "127.0.0.1:2019"}); err == nil {
		t.Fatal("admin-URL zonder schema moet fout geven")
	}
}

func TestSetRouteProxyAndRedirect(t *testing.T) {
	ctx := context.Background()
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{})
	if err := c.SetRoute(ctx, Route{Host: "Site.Test", ServerUUID: "u1", Upstream: Upstream{Container: "panel-u1", Port: 8080}}); err != nil {
		t.Fatal(err)
	}
	if err := c.SetRoute(ctx, Route{Host: "www.site.test", RedirectTo: "SITE.test", Upstream: Upstream{Container: "ignored", Port: 1}}); err != nil {
		t.Fatal(err)
	}
	got := f.snapshot()
	if len(got) != 4 {
		t.Fatalf("verwacht 2 vaste + 2 dynamische routes, kreeg %d", len(got))
	}
	if mustJSON(got[0]) != mustJSON(fixedRoutes()[0]) || mustJSON(got[1]) != mustJSON(fixedRoutes()[1]) {
		t.Fatal("vaste routes zijn gewijzigd of verplaatst")
	}
	p := f.find("panel-dyn-site.test")
	if p == nil {
		t.Fatalf("route niet gevonden; ids = %v", f.ids())
	}
	js := mustJSON(p)
	for _, want := range []string{`"host":["site.test"]`, `"dial":"panel-u1:8080"`, `"handler":"reverse_proxy"`, `"panel_server_uuid":"u1"`, `"terminal":true`} {
		if !strings.Contains(js, want) {
			t.Errorf("route mist %s: %s", want, js)
		}
	}
	rd := mustJSON(f.find("panel-dyn-www.site.test"))
	for _, want := range []string{`"status_code":308`, `"Location":["https://site.test{http.request.uri}"]`} {
		if !strings.Contains(rd, want) {
			t.Errorf("redirect mist %s: %s", want, rd)
		}
	}
	if strings.Contains(rd, "reverse_proxy") {
		t.Errorf("redirect mag geen upstream hebben: %s", rd)
	}

	// Vervangen met dezelfde host (andere hoofdletters) → nog steeds één route.
	if err := c.SetRoute(ctx, Route{Host: "SITE.TEST", Upstream: Upstream{Container: "panel-u2", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	if n := len(f.snapshot()); n != 4 {
		t.Fatalf("vervangen gaf %d routes", n)
	}
	if !strings.Contains(mustJSON(f.find("panel-dyn-site.test")), `"dial":"panel-u2:80"`) {
		t.Fatal("route niet bijgewerkt")
	}

	if err := c.RemoveRoute(ctx, "Site.test"); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveRoute(ctx, "site.test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("verwacht ErrNotFound, kreeg %v", err)
	}
	if err := c.RemoveRoute(ctx, "panel.test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("vaste route mag niet weg: %v", err)
	}
	if n := len(f.snapshot()); n != 3 {
		t.Fatalf("na verwijderen %d routes", n)
	}
}

func TestValidation(t *testing.T) {
	ctx := context.Background()
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{})
	bad := []Route{
		{Host: "", Upstream: Upstream{Container: "c", Port: 80}},
		{Host: "a b.test", Upstream: Upstream{Container: "c", Port: 80}},
		{Host: `x.test"},{"`, Upstream: Upstream{Container: "c", Port: 80}},
		{Host: "a.test", Upstream: Upstream{Container: "", Port: 80}},
		{Host: "a.test", Upstream: Upstream{Container: "c:1", Port: 80}},
		{Host: "a.test", Upstream: Upstream{Container: "c", Port: 0}},
		{Host: "a.test", RedirectTo: "a.test"},
		{Host: "a.test", RedirectTo: "b.test/pad"},
		{Host: "*.a.test", Upstream: Upstream{Container: "c", Port: 80}}, // Wildcard-vlag ontbreekt
		{Host: "a.test", Wildcard: true, Upstream: Upstream{Container: "c", Port: 80}},
		{Host: "a.test", Upstream: Upstream{Container: "c", Port: 80, Network: "n"}}, // geen CaddyContainer
		{Host: "Panel.Test", Upstream: Upstream{Container: "c", Port: 80}},           // vaste route
	}
	for _, r := range bad {
		if err := c.SetRoute(ctx, r); err == nil {
			t.Errorf("verwacht fout voor %+v", r)
		}
	}
	if f.patches != 0 {
		t.Fatalf("ongeldige routes gaven %d PATCHes", f.patches)
	}
}

func TestSyncExactSetAndOrder(t *testing.T) {
	ctx := context.Background()
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{})
	_ = c.SetRoute(ctx, Route{Host: "old.test", Upstream: Upstream{Container: "c", Port: 80}})
	_ = c.SetRoute(ctx, Route{Host: "keep.test", Upstream: Upstream{Container: "c", Port: 80}})

	routes := []Route{
		{Host: "*.b.test", Wildcard: true, Upstream: Upstream{Container: "w", Port: 80}},
		{Host: "*.x.b.test", Wildcard: true, Upstream: Upstream{Container: "w2", Port: 80}},
		{Host: "keep.test", Upstream: Upstream{Container: "c2", Port: 81}},
		{Host: "A.B.test", Upstream: Upstream{Container: "a", Port: 80}},
	}
	if err := c.Sync(ctx, routes); err != nil {
		t.Fatal(err)
	}
	want := []string{"", "", "panel-dyn-a.b.test", "panel-dyn-keep.test", "panel-dyn-_.x.b.test", "panel-dyn-_.b.test"}
	if got := f.ids(); mustJSON(got) != mustJSON(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	if !strings.Contains(mustJSON(f.find("panel-dyn-keep.test")), `"dial":"c2:81"`) {
		t.Fatal("keep.test niet bijgewerkt")
	}
	// Ongewijzigde Sync schrijft niets (geen onnodige Caddy-reload).
	n := f.patches
	if err := c.Sync(ctx, routes); err != nil {
		t.Fatal(err)
	}
	if f.patches != n {
		t.Fatalf("Sync zonder wijziging deed een PATCH")
	}
	// Ongeldige route in Sync: rest gaat door, fout wordt gemeld.
	err := c.Sync(ctx, []Route{{Host: "ok.test", Upstream: Upstream{Container: "c", Port: 80}}, {Host: "bad host"}, {Host: "panel.test", Upstream: Upstream{Container: "c", Port: 80}}})
	if err == nil {
		t.Fatal("verwacht fout voor ongeldige routes")
	}
	if got := f.ids(); mustJSON(got) != mustJSON([]string{"", "", "panel-dyn-ok.test"}) {
		t.Fatalf("ids = %v", got)
	}
	// Lege Sync haalt alle dynamische routes weg, vaste blijven.
	if err := c.Sync(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if got := f.snapshot(); mustJSON(got) != mustJSON(fixedRoutes()) {
		t.Fatalf("na lege Sync: %s", mustJSON(got))
	}
}

func TestRetryOnConflict(t *testing.T) {
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{})
	f.fail412 = 2
	if err := c.SetRoute(context.Background(), Route{Host: "a.test", Upstream: Upstream{Container: "c", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	f.fail412 = 100
	if err := c.SetRoute(context.Background(), Route{Host: "b.test", Upstream: Upstream{Container: "c", Port: 80}}); err == nil {
		t.Fatal("verwacht fout na herhaalde 412")
	}
}

func TestConcurrentSetRoute(t *testing.T) {
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{})
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- c.SetRoute(context.Background(), Route{Host: fmt.Sprintf("s%d.test", i), Upstream: Upstream{Container: "c", Port: 80}})
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := len(f.snapshot()); n != 22 {
		t.Fatalf("verwacht 22 routes, kreeg %d", n)
	}
}

func TestHealthy(t *testing.T) {
	ctx := context.Background()
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{})
	if err := c.Healthy(ctx); err != nil {
		t.Fatal(err)
	}
	_ = c.SetRoute(ctx, Route{Host: "a.test", Upstream: Upstream{Container: "c", Port: 80}})
	if err := c.Healthy(ctx); err != nil {
		t.Fatal(err)
	}
	// Caddy herstart: alleen de basisconfig is er nog.
	f.mu.Lock()
	f.routes = fixedRoutes()
	f.mu.Unlock()
	if err := c.Healthy(ctx); err == nil {
		t.Fatal("Healthy moet falen als de dynamische routes weg zijn")
	}
	if err := c.Healthy(ctx); err != nil {
		t.Fatalf("tweede check moet slagen zodat de daemon Sync doet: %v", err)
	}
	f.mu.Lock()
	f.down = true
	f.mu.Unlock()
	if err := c.Healthy(ctx); err == nil {
		t.Fatal("Healthy moet falen als Caddy niet antwoordt")
	}
	f.srv.Close()
	if err := c.Healthy(ctx); err == nil {
		t.Fatal("Healthy moet falen als Caddy weg is")
	}
}

func TestStatus(t *testing.T) {
	ctx := context.Background()
	f := newFakeAdmin(t)
	// TLS-server met een certificaat voor example.com (httptest-standaard).
	tlsSrv := httptest.NewTLSServer(http.NotFoundHandler())
	defer tlsSrv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(tlsSrv.Certificate())
	c := newTestCaddy(t, f, CaddyOptions{TLSAddr: tlsSrv.Listener.Addr().String(), ExtraRoots: pool})

	if _, err := c.Status(ctx, "example.com"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("verwacht ErrNotFound, kreeg %v", err)
	}
	_ = c.SetRoute(ctx, Route{Host: "example.com", Upstream: Upstream{Container: "c", Port: 80}})
	_ = c.SetRoute(ctx, Route{Host: "other.test", Upstream: Upstream{Container: "c", Port: 80}})
	st, err := c.Status(ctx, "EXAMPLE.com")
	if err != nil || st.SSL != SSLActive || st.Host != "example.com" || st.CheckedAt.IsZero() {
		t.Fatalf("status = %+v, %v", st, err)
	}
	st, err = c.Status(ctx, "other.test")
	if err != nil || st.SSL != SSLIssuing || st.Error == "" {
		t.Fatalf("certificaat voor andere naam moet issuing zijn: %+v, %v", st, err)
	}
	c.tlsAddr = "127.0.0.1:1"
	st, err = c.Status(ctx, "example.com")
	if err != nil || st.SSL != SSLPending || st.Error == "" {
		t.Fatalf("onbereikbaar moet pending zijn: %+v, %v", st, err)
	}
}

// ---- netwerk-koppeling ----

type fakeDocker struct {
	mu       sync.Mutex
	networks map[string]NetworkInfo // op naam
	attached map[string]bool        // netwerk-ID's waar Caddy aan hangt
	calls    []string
}

func (d *fakeDocker) Network(_ context.Context, idOrName string) (NetworkInfo, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, n := range d.networks {
		if n.ID == idOrName || n.Name == idOrName {
			return n, nil
		}
	}
	return NetworkInfo{}, fmt.Errorf("network %s not found", idOrName)
}

func (d *fakeDocker) ContainerNetworks(_ context.Context, _ string) (map[string]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := map[string]string{}
	for _, n := range d.networks {
		if d.attached[n.ID] {
			out[n.ID] = n.Name
		}
	}
	return out, nil
}

func (d *fakeDocker) Connect(_ context.Context, id, _ string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.attached[id] = true
	d.calls = append(d.calls, "connect "+id)
	return nil
}

func (d *fakeDocker) Disconnect(_ context.Context, id, _ string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.attached, id)
	d.calls = append(d.calls, "disconnect "+id)
	return nil
}

func TestNetworkCoupling(t *testing.T) {
	ctx := context.Background()
	own := map[string]string{"panel.managed": "true", "panel.instance": "t1"}
	d := &fakeDocker{
		networks: map[string]NetworkInfo{
			"site1":   {ID: "id-site1", Name: "site1", Labels: own},
			"site2":   {ID: "id-site2", Name: "site2", Labels: own},
			"compose": {ID: "id-compose", Name: "compose", Labels: map[string]string{"panel.managed": "true", "panel.instance": "t1", "com.docker.compose.project": "panel"}},
			"other":   {ID: "id-other", Name: "other", Labels: map[string]string{"panel.managed": "true", "panel.instance": "main"}},
			"plain":   {ID: "id-plain", Name: "plain"},
		},
		attached: map[string]bool{"id-compose": true, "id-other": true, "id-plain": true},
	}
	f := newFakeAdmin(t)
	c := newTestCaddy(t, f, CaddyOptions{Docker: d})

	r1 := Route{Host: "a.test", Upstream: Upstream{Container: "c1", Port: 80, Network: "site1"}}
	r2 := Route{Host: "b.test", Upstream: Upstream{Container: "c2", Port: 80, Network: "site1"}}
	if err := c.SetRoute(ctx, r1); err != nil {
		t.Fatal(err)
	}
	if err := c.SetRoute(ctx, r2); err != nil {
		t.Fatal(err)
	}
	if !d.attached["id-site1"] || len(d.calls) != 1 {
		t.Fatalf("verwacht één connect met site1: %v", d.calls)
	}
	if err := c.SetRoute(ctx, Route{Host: "x.test", Upstream: Upstream{Container: "c", Port: 80, Network: "other"}}); err == nil {
		t.Fatal("netwerk van een andere instance moet geweigerd worden")
	}
	if err := c.SetRoute(ctx, Route{Host: "x.test", Upstream: Upstream{Container: "c", Port: 80, Network: "plain"}}); err == nil {
		t.Fatal("netwerk zonder labels moet geweigerd worden")
	}
	if err := c.RemoveRoute(ctx, "a.test"); err != nil {
		t.Fatal(err)
	}
	if !d.attached["id-site1"] {
		t.Fatal("site1 is losgekoppeld terwijl b.test er nog naar wijst")
	}
	// b.test naar een ander netwerk → site2 erbij, site1 los.
	r2.Upstream.Network = "site2"
	if err := c.SetRoute(ctx, r2); err != nil {
		t.Fatal(err)
	}
	if d.attached["id-site1"] || !d.attached["id-site2"] {
		t.Fatalf("attached = %v", d.attached)
	}
	// Sync zonder routes: alles van ons los, de rest blijft.
	if err := c.Sync(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if d.attached["id-site2"] || !d.attached["id-compose"] || !d.attached["id-other"] || !d.attached["id-plain"] {
		t.Fatalf("attached na lege Sync = %v", d.attached)
	}
	// Redirect-routes hebben geen netwerk nodig.
	if err := c.SetRoute(ctx, Route{Host: "r.test", RedirectTo: "b.test", Upstream: Upstream{Network: "site1"}}); err != nil {
		t.Fatal(err)
	}
	if d.attached["id-site1"] {
		t.Fatal("redirect mag geen netwerk koppelen")
	}
}
