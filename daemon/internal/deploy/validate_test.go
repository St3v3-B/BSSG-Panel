package deploy

import (
	"strings"
	"testing"
)

func TestParseRemote(t *testing.T) {
	ok := map[string]Remote{
		"https://github.com/acme/site.git":        {Scheme: "https", Host: "github.com", Port: 443},
		"https://git.example.test:8443/a/b":       {Scheme: "https", Host: "git.example.test", Port: 8443},
		"git@github.com:acme/site.git":            {Scheme: "ssh", Host: "github.com", Port: 22},
		"ssh://git@gitlab.com:2222/acme/site.git": {Scheme: "ssh", Host: "gitlab.com", Port: 2222},
		"ssh://GitHub.com/acme/site.git":          {Scheme: "ssh", Host: "github.com", Port: 22},
	}
	for raw, want := range ok {
		got, err := ParseRemote(raw, false)
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if got.Scheme != want.Scheme || got.Host != want.Host || got.Port != want.Port || got.URL != raw {
			t.Errorf("%s: got %+v", raw, got)
		}
	}
	bad := []string{
		"", "file:///etc/passwd", "/srv/repo.git", "./repo", "../repo", "ext::sh -c touch% /tmp/x",
		"https://user:token@github.com/a/b.git", "https://github.com/a/b.git?x=1", "https://github.com/a/b#frag",
		"http://github.com/a/b.git", "git://github.com/a/b.git", "-uhttps://github.com/a/b", "https://-oProxy/a",
		"https://github.com/a/b c", "https://github.com/a/b\n", "git@github.com:-oProxyCommand=x", "git@github.com:../../etc",
		"ssh://-oProxyCommand=x/a", "ssh://user:pw@github.com/a", "https://github.com/a/$(id)", "fd::17",
		"https://github.com/" + strings.Repeat("a", 600), "transport::https://github.com/a",
	}
	for _, raw := range bad {
		if _, err := ParseRemote(raw, false); err == nil {
			t.Errorf("%q: accepted", raw)
		}
	}
	if _, err := ParseRemote("http://git-test:8080/repo.git", true); err != nil {
		t.Errorf("http with allowHTTP: %v", err)
	}
}

func TestValidBranch(t *testing.T) {
	for _, b := range []string{"main", "release/1.2", "feature-x", "v1.0_rc"} {
		if err := ValidBranch(b); err != nil {
			t.Errorf("%s: %v", b, err)
		}
	}
	for _, b := range []string{"", "-x", "--upload-pack=x", "a..b", "a b", "/a", "a/", "a.lock", "HEAD", "a//b", ".x", "a/.b", "a:b", "a~1", "a^", "a\\b", "a@{1}"} {
		if ValidBranch(b) == nil {
			t.Errorf("%q: accepted", b)
		}
	}
}

func baseReq() Request {
	return Request{DeployID: 1, RepoURL: "https://github.com/acme/site.git", Branch: "main", TargetDir: "/public", SourceDir: "/", Auth: Auth{Type: "none"}}
}

func TestRequestValidate(t *testing.T) {
	r := baseReq()
	r.SharedPaths = []string{"/.env", "uploads/", ".env"}
	r.Build = &Build{Command: "  npm ci  ", Image: "node:22-alpine"}
	if _, err := r.Validate(false); err != nil {
		t.Fatal(err)
	}
	if r.TargetDir != "public" || r.SourceDir != "." || strings.Join(r.SharedPaths, ",") != ".env,uploads" || r.Build.Command != "npm ci" || r.TimeoutSeconds != 1800 || r.LogLines != 300 {
		t.Fatalf("normalised: %+v", r)
	}
	cases := map[string]func(*Request){
		"root target":     func(r *Request) { r.TargetDir = "/" },
		"escape target":   func(r *Request) { r.TargetDir = "/../x" },
		"stage target":    func(r *Request) { r.TargetDir = "/.panel-deploy/x" },
		"escape source":   func(r *Request) { r.SourceDir = "../" },
		"escape shared":   func(r *Request) { r.SharedPaths = []string{"../../etc"} },
		"nested shared":   func(r *Request) { r.SharedPaths = []string{"wp-content", "wp-content/uploads"} },
		"newline shared":  func(r *Request) { r.SharedPaths = []string{"a\nb"} },
		"token over ssh":  func(r *Request) { r.RepoURL = "git@github.com:a/b.git"; r.Auth = Auth{Type: "token", Token: "abcd"} },
		"ssh without key": func(r *Request) { r.RepoURL = "git@github.com:a/b.git"; r.Auth = Auth{Type: "ssh"} },
		"ssh over https": func(r *Request) {
			r.Auth = Auth{Type: "ssh", PrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----", KnownHosts: "x"}
		},
		"ssh url w/o auth": func(r *Request) { r.RepoURL = "git@github.com:a/b.git" },
		"bad image":        func(r *Request) { r.Build = &Build{Command: "x", Image: "Bad Image"} },
		"token newline":    func(r *Request) { r.Auth = Auth{Type: "token", Token: "ab\ncd"} },
		"no id":            func(r *Request) { r.DeployID = 0 },
		"bad branch":       func(r *Request) { r.Branch = "--x" },
		"unknown auth":     func(r *Request) { r.Auth = Auth{Type: "password"} },
		"timeout":          func(r *Request) { r.TimeoutSeconds = 5 },
	}
	for name, mut := range cases {
		r := baseReq()
		mut(&r)
		if _, err := r.Validate(false); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	r = baseReq()
	r.Auth = Auth{Type: "token", Token: "ghp_secret"}
	if _, err := r.Validate(false); err != nil || r.Auth.Username != "x-access-token" {
		t.Fatalf("token default user: %v %+v", err, r.Auth)
	}
	if s := r.Auth.String(); strings.Contains(s, "ghp_secret") {
		t.Fatal("Auth.String leaks the token")
	}
}

func TestRedactor(t *testing.T) {
	key := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----"
	r := NewRedactor("x-access-token", "ghp_supersecret123", key)
	in := "fatal: Authentication failed for https://x-access-token:ghp_supersecret123@github.com/a | Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3N1cGVyc2VjcmV0MTIz b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ \x1b[31mred"
	out := r.Line(in)
	for _, leak := range []string{"ghp_supersecret123", "eC1hY2Nlc3MtdG9rZW46Z2hwX3N1cGVyc2VjcmV0MTIz", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "\x1b"} {
		if strings.Contains(out, leak) {
			t.Fatalf("leak %q in %q", leak, out)
		}
	}
	if !strings.Contains(r.Line("https://u:p@host/x"), "https://***@host/x") {
		t.Fatal("userinfo not redacted")
	}
}
