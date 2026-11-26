package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validSpec() ServerSpec {
	return ServerSpec{
		UUID: "0b7c2d1e-1111-4222-8333-444455556666", Type: "game", Image: "alpine:3.20",
		Startup: "java -Xmx{{SERVER_MEMORY}}M -jar {{JAR}}", Stop: Stop{Type: "command", Value: "stop"},
		ReadyPattern: `Done \(`, Environment: map[string]string{"JAR": "server.jar"},
		Limits:      Limits{CPUPct: 100, MemoryMB: 1024, SwapMB: 0, DiskMB: 0},
		Allocations: []Allocation{{IP: "127.0.0.1", Port: 25565}, {IP: "0.0.0.0", Port: 25566, Primary: true}},
		Install:     Install{Image: "alpine:3.20", Script: "echo hi"},
	}
}

func TestValidate(t *testing.T) {
	s := validSpec()
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := []func(*ServerSpec){
		func(s *ServerSpec) { s.UUID = "nope" },
		func(s *ServerSpec) { s.Type = "x" },
		func(s *ServerSpec) { s.Image = "" },
		func(s *ServerSpec) { s.Stop = Stop{Type: "signal", Value: "SIGHUP"} },
		func(s *ServerSpec) { s.ReadyPattern = "(" },
		func(s *ServerSpec) { s.Limits.MemoryMB = 10 },
		func(s *ServerSpec) { s.Limits.SwapMB = -2 },
		func(s *ServerSpec) { p := 5; s.Limits.Pids = &p },
		func(s *ServerSpec) { s.Allocations[0].Port = 0 },
		func(s *ServerSpec) { s.Allocations[0].IP = "::1" },
		func(s *ServerSpec) { s.Install.Script = "" },
		func(s *ServerSpec) { s.Environment["1BAD"] = "x" },
		func(s *ServerSpec) { s.ConfigFiles = []ConfigFile{{Path: "/", Format: "yaml"}} },
		func(s *ServerSpec) { s.ConfigFiles = []ConfigFile{{Path: "a.toml", Format: "ini"}} },
	}
	for i, f := range bad {
		s := validSpec()
		s.Environment = map[string]string{}
		f(&s)
		if err := s.Validate(); err == nil {
			t.Errorf("geval %d: verwacht fout", i)
		}
	}
}

func TestVarsAndExpand(t *testing.T) {
	s := validSpec()
	s.Environment["SERVER_PORT"] = "1" // ingebouwd gaat voor
	v := s.Vars()
	if v["SERVER_PORT"] != "25566" || v["SERVER_IP"] != "0.0.0.0" || v["SERVER_MEMORY"] != "1024" || v["TZ"] != "Europe/Amsterdam" || v["SERVER_UUID"] != s.UUID {
		t.Fatalf("vars: %v", v)
	}
	got := Expand(s.Startup+" {{ JAR }} {{UNKNOWN}}", v)
	if got != "java -Xmx1024M -jar server.jar server.jar {{UNKNOWN}}" {
		t.Fatalf("expand: %q", got)
	}
	s.Allocations[1].Primary = false
	if s.Vars()["SERVER_PORT"] != "25565" {
		t.Fatal("zonder primary: eerste allocation")
	}
	if l := EnvList(map[string]string{"B": "2", "A": "1"}); strings.Join(l, ",") != "A=1,B=2" {
		t.Fatal(l)
	}
}

func TestSameAs(t *testing.T) {
	a, b := validSpec(), validSpec()
	b.StartOnInstall = true
	b.SkipInstall = true
	if !a.SameAs(b) {
		t.Fatal("vlaggen tellen niet mee")
	}
	b.Image = "other"
	if a.SameAs(b) {
		t.Fatal("image telt wel mee")
	}
	// JSON-roundtrip met lege velden
	var c ServerSpec
	data, _ := json.Marshal(a)
	_ = json.Unmarshal(data, &c)
	if !a.SameAs(c) {
		t.Fatal("roundtrip")
	}
}

func TestCleanRel(t *testing.T) {
	cases := map[string]string{
		"server.properties":                "server.properties",
		"/home/container/config/paper.yml": "config/paper.yml",
		"../../etc/passwd":                 "etc/passwd",
		"/a/../../b":                       "b",
		"/home/containerX/a":               "home/containerX/a",
	}
	for in, want := range cases {
		got, err := CleanRel(in)
		if err != nil || got != want {
			t.Errorf("%q → %q, %v (want %q)", in, got, err, want)
		}
	}
	for _, in := range []string{"", "/", "/home/container", "..", "a\x00b"} {
		if _, err := CleanRel(in); err == nil {
			t.Errorf("%q: verwacht fout", in)
		}
	}
}

func TestSafePathRejectsSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "f"), filepath.Join(root, "f")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"link/x.yml", "f"} {
		if _, err := SafePath(root, p, os.Getuid(), os.Getgid()); err == nil {
			t.Errorf("%s: symlink niet geweigerd", p)
		}
	}
	p, err := SafePath(root, "a/b/c.yml", os.Getuid(), os.Getgid())
	if err != nil || p != filepath.Join(root, "a/b/c.yml") {
		t.Fatal(p, err)
	}
	if fi, err := os.Stat(filepath.Join(root, "a/b")); err != nil || !fi.IsDir() {
		t.Fatal("tussenmappen niet aangemaakt")
	}
}

func TestUpdateProperties(t *testing.T) {
	old := "#Minecraft server properties\nserver-port=25565\nmotd = Hallo\nserver-ip=\n"
	got := string(UpdateProperties([]byte(old), map[string]string{"server-port": "30000", "server-ip": "1.2.3.4", "online-mode": "true"}))
	want := "#Minecraft server properties\nserver-port=30000\nmotd = Hallo\nserver-ip=1.2.3.4\nonline-mode=true\n"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if got := string(UpdateProperties(nil, map[string]string{"b": "2", "a": "1"})); got != "a=1\nb=2\n" {
		t.Fatal(got)
	}
}

func TestUpdateYAML(t *testing.T) {
	old := "# commentaar\nsettings:\n  bungeecord: false\n  name: x\nother: 1\n"
	out, err := UpdateYAML([]byte(old), map[string]string{"settings.bungeecord": "true", "settings.motd": "hallo: wereld", "new.deep.key": "5"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"# commentaar", "bungeecord: true", `motd: 'hallo: wereld'`, "other: 1", "new:\n  deep:\n    key: 5"} {
		if !strings.Contains(s, want) {
			t.Errorf("mist %q in\n%s", want, s)
		}
	}
	if _, err := UpdateYAML([]byte("- a\n- b\n"), map[string]string{"x": "1"}); err == nil {
		t.Error("lijst als root: verwacht fout")
	}
}

func TestUpdateJSON(t *testing.T) {
	out, err := UpdateJSON([]byte(`{"a":{"b":1},"keep":"x","big":12345678901234567890}`), map[string]string{"a.b": "2", "a.c": "tekst", "flag": "true", "n": "null"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err, string(out))
	}
	a := m["a"].(map[string]any)
	if a["b"] != 2.0 || a["c"] != "tekst" || m["flag"] != true || m["n"] != nil || m["keep"] != "x" {
		t.Fatalf("%s", out)
	}
	if !strings.Contains(string(out), "12345678901234567890") {
		t.Fatal("groot getal verloren")
	}
}

func TestApplyConfigFiles(t *testing.T) {
	root := t.TempDir()
	s := validSpec()
	s.ConfigFiles = []ConfigFile{
		{Path: "server.properties", Format: "properties", Set: map[string]string{"server-port": "{{SERVER_PORT}}", "server-ip": "{{SERVER_IP}}"}},
		{Path: "/home/container/config/x.json", Format: "json", Set: map[string]string{"mem": "{{SERVER_MEMORY}}"}},
	}
	if err := ApplyConfigFiles(root, s.ConfigFiles, s.Vars(), os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(root, "server.properties"))
	if string(b) != "server-ip=0.0.0.0\nserver-port=25566\n" {
		t.Fatalf("%q", b)
	}
	b, _ = os.ReadFile(filepath.Join(root, "config/x.json"))
	if !strings.Contains(string(b), `"mem": 1024`) {
		t.Fatalf("%s", b)
	}
}
