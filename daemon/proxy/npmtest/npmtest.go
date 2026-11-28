// Package npmtest is een nep van de Nginx Proxy Manager-API voor tests (proxy- en daemon-tests).
// Velden zijn alleen met Mu vast te lezen of te wijzigen terwijl de server draait.
package npmtest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Server is een httptest-nep van de NPM-API (zie npm_client.go voor de vorm).
type Server struct {
	Mu       sync.Mutex
	Email    string
	Password string
	Version  [3]int
	TwoFA    bool
	Tokens   map[string]time.Time // token → verloopt
	Logins   int
	NextID   int
	Hosts    map[int]map[string]any
	Certs    map[int]map[string]any
	Redirect []string // domeinen van redirection hosts (niet van ons, niet in de proxy-host-lijst)
	CertFail map[string]string
	CertReqs []map[string]any
	Puts     int
	Deletes  []int
	Now      func() time.Time
	TTL      time.Duration
	URL      string
	srv      *httptest.Server
}

// New start de nep; URL is het adres voor NPMSettings.URL. Gebruiker admin@panel.test / s3cret, versie 2.17.1.
func New(t testing.TB) *Server {
	f := &Server{Email: "admin@panel.test", Password: "s3cret", Version: [3]int{2, 17, 1}, Tokens: map[string]time.Time{},
		Hosts: map[int]map[string]any{}, Certs: map[int]map[string]any{}, CertFail: map[string]string{}, Now: time.Now, TTL: 24 * time.Hour}
	f.srv = httptest.NewServer(f)
	f.URL = f.srv.URL
	t.Cleanup(f.srv.Close)
	return f
}

// NewID geeft een nieuw id (Mu vasthouden).
func (f *Server) NewID() int { f.NextID++; return f.NextID }

func writeNPM(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func npmErr(w http.ResponseWriter, code int, msg string) {
	writeNPM(w, code, map[string]any{"error": map[string]any{"code": code, "message": msg}})
}

func (f *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if r.URL.Path == "/api/" || r.URL.Path == "/api" {
		writeNPM(w, 200, map[string]any{"status": "OK", "setup": true, "version": map[string]int{"major": f.Version[0], "minor": f.Version[1], "revision": f.Version[2]}})
		return
	}
	if r.URL.Path == "/api/tokens" && r.Method == http.MethodPost {
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b["identity"] != f.Email || b["secret"] != f.Password {
			npmErr(w, 401, "Invalid email or password")
			return
		}
		if f.TwoFA {
			writeNPM(w, 200, map[string]any{"requires_2fa": true, "challenge_token": "x"})
			return
		}
		f.Logins++
		tok := "tok-" + strconv.Itoa(f.Logins)
		exp := f.Now().Add(f.TTL)
		f.Tokens[tok] = exp
		writeNPM(w, 200, map[string]any{"token": tok, "expires": exp.UTC().Format(time.RFC3339Nano)})
		return
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if exp, ok := f.Tokens[tok]; !ok || !exp.After(f.Now()) {
		npmErr(w, 401, "Token has expired")
		return
	}
	var body map[string]any
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // api nginx proxy-hosts [id]
	if len(parts) < 3 || parts[0] != "api" || parts[1] != "nginx" {
		npmErr(w, 404, "Not Found")
		return
	}
	var id int
	if len(parts) == 4 {
		id, _ = strconv.Atoi(parts[3])
	}
	switch parts[2] {
	case "proxy-hosts":
		f.proxyHosts(w, r.Method, id, body)
	case "certificates":
		f.certificates(w, r.Method, id, body)
	default:
		npmErr(w, 404, "Not Found")
	}
}

func (f *Server) taken(domain string, except int) bool {
	for id, h := range f.Hosts {
		if id == except {
			continue
		}
		for _, d := range h["domain_names"].([]any) {
			if d.(string) == domain {
				return true
			}
		}
	}
	for _, d := range f.Redirect {
		if d == domain {
			return true
		}
	}
	return false
}

func (f *Server) proxyHosts(w http.ResponseWriter, method string, id int, body map[string]any) {
	allowed := map[string]bool{"domain_names": true, "forward_scheme": true, "forward_host": true, "forward_port": true, "certificate_id": true, "ssl_forced": true,
		"hsts_enabled": true, "hsts_subdomains": true, "trust_forwarded_proto": true, "http2_support": true, "block_exploits": true, "caching_enabled": true,
		"allow_websocket_upgrade": true, "access_list_id": true, "advanced_config": true, "enabled": true, "meta": true, "locations": true}
	for k := range body {
		if !allowed[k] {
			npmErr(w, 400, "data must NOT have additional properties: "+k)
			return
		}
	}
	switch {
	case method == http.MethodGet && id == 0:
		list := []map[string]any{}
		for i := 1; i <= f.NextID; i++ {
			if h, ok := f.Hosts[i]; ok {
				list = append(list, h)
			}
		}
		writeNPM(w, 200, list)
	case method == http.MethodPost:
		for _, d := range body["domain_names"].([]any) {
			if f.taken(d.(string), 0) {
				npmErr(w, 400, d.(string)+" is already in use")
				return
			}
		}
		nid := f.NewID()
		body["id"] = nid
		if body["certificate_id"] == nil || body["certificate_id"].(float64) == 0 {
			body["ssl_forced"], body["http2_support"] = false, false // cleanSslHstsData
		}
		if _, ok := body["enabled"]; !ok {
			body["enabled"] = true
		}
		f.Hosts[nid] = body
		writeNPM(w, 201, body)
	case method == http.MethodPut:
		h, ok := f.Hosts[id]
		if !ok {
			npmErr(w, 404, "Not Found")
			return
		}
		f.Puts++
		for k, v := range body {
			h[k] = v
		}
		writeNPM(w, 200, h)
	case method == http.MethodDelete:
		if _, ok := f.Hosts[id]; !ok {
			npmErr(w, 404, "Not Found")
			return
		}
		delete(f.Hosts, id)
		f.Deletes = append(f.Deletes, id)
		writeNPM(w, 200, true)
	default:
		npmErr(w, 405, "method")
	}
}

func (f *Server) certificates(w http.ResponseWriter, method string, id int, body map[string]any) {
	switch {
	case method == http.MethodGet:
		list := []map[string]any{}
		for i := 1; i <= f.NextID; i++ {
			if c, ok := f.Certs[i]; ok {
				list = append(list, c)
			}
		}
		writeNPM(w, 200, list)
	case method == http.MethodPost:
		f.CertReqs = append(f.CertReqs, body)
		meta, _ := body["meta"].(map[string]any)
		if f.Version[1] >= 13 {
			if _, ok := meta["letsencrypt_email"]; ok {
				npmErr(w, 400, "data/meta must NOT have additional properties")
				return
			}
		}
		d := body["domain_names"].([]any)[0].(string)
		if msg, ok := f.CertFail[d]; ok {
			npmErr(w, 500, msg)
			return
		}
		nid := f.NewID()
		c := map[string]any{"id": nid, "provider": "letsencrypt", "nice_name": d, "domain_names": body["domain_names"],
			"expires_on": f.Now().Add(90 * 24 * time.Hour).UTC().Format("2006-01-02 15:04:05"), "meta": map[string]any{"dns_challenge": meta["dns_challenge"]}}
		f.Certs[nid] = c
		writeNPM(w, 201, c)
	case method == http.MethodDelete:
		delete(f.Certs, id)
		writeNPM(w, 200, true)
	}
}

// HostByDomain geeft de proxy host met domein d (of nil).
func (f *Server) HostByDomain(d string) map[string]any {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	for _, h := range f.Hosts {
		for _, x := range h["domain_names"].([]any) {
			if x.(string) == d {
				return h
			}
		}
	}
	return nil
}

// UserHost zet een proxy host van de gebruiker (zonder marker) in de nep.
func (f *Server) UserHost(domain string) int {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	id := f.NewID()
	f.Hosts[id] = map[string]any{"id": id, "domain_names": []any{domain}, "forward_scheme": "http", "forward_host": "10.0.0.5", "forward_port": float64(3000),
		"certificate_id": float64(0), "ssl_forced": false, "http2_support": false, "allow_websocket_upgrade": false, "block_exploits": true, "enabled": true,
		"advanced_config": "# my own host", "meta": map[string]any{}}
	return id
}
