package backup

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"panel/daemon/internal/engine"
)

const testUUID = "8f6c1a2e-1b2c-4d3e-9f40-a1b2c3d4e5f6"

func TestRepoURL(t *testing.T) {
	cases := []struct {
		ep, want string
	}{
		{"https://s3.node1.test", "s3:https://s3.node1.test/bk/restic/" + testUUID},
		{"http://127.0.0.1:9000/", "s3:http://127.0.0.1:9000/bk/restic/" + testUUID},
		{"s3.node1.test", "s3:https://s3.node1.test/bk/restic/" + testUUID},
	}
	for _, c := range cases {
		got, err := RepoURL(S3{Endpoint: c.ep, Bucket: "bk"}, testUUID)
		if err != nil || got != c.want {
			t.Errorf("RepoURL(%q) = %q, %v; want %q", c.ep, got, err, c.want)
		}
	}
	for _, bad := range []S3{{Endpoint: "ftp://x", Bucket: "bk"}, {Endpoint: "https://x/y", Bucket: "bk"}, {Endpoint: "https://u:p@x", Bucket: "bk"}, {Endpoint: "https://x", Bucket: "b/k"}} {
		if _, err := RepoURL(bad, testUUID); err == nil {
			t.Errorf("RepoURL(%+v) accepted", bad.Endpoint)
		}
	}
	if _, err := RepoURL(S3{Endpoint: "https://x", Bucket: "bk"}, "../etc"); err == nil {
		t.Error("bad uuid accepted")
	}
}

func TestCleanRel(t *testing.T) {
	ok := map[string]string{"": ".", "/": ".", "world": "world", "/world/region/": "world/region", "a//b/./c": "a/b/c", "we*ird.txt": "we*ird.txt"}
	for in, want := range ok {
		if got, err := CleanRel(in); err != nil || got != want {
			t.Errorf("CleanRel(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"..", "../x", "a/../../b", "a/..", "x\x00y", "a\nb", `a\b`} {
		if _, err := CleanRel(bad); err == nil {
			t.Errorf("CleanRel(%q) accepted", bad)
		}
	}
}

func TestArgs(t *testing.T) {
	got := backupArgs(7, []string{"/.panel-deploy", "logs/*", "*.tmp", "cache/", " ", "/"}, true)
	want := []string{"backup", "--json", "--host", "panel", "--tag", "panel-backup-7", "--exclude", "/home/container/_databases",
		"--exclude", "/home/container/.panel-deploy", "--exclude", "/home/container/logs/*", "--exclude", "*.tmp", "--exclude", "cache",
		"/home/container", "/_databases"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("backupArgs:\n got %q\nwant %q", got, want)
	}
	if got := backupArgs(1, nil, false); got[len(got)-1] != "/home/container" {
		t.Errorf("zonder dumps: %q", got)
	}
	if got, want := forgetArgs(Retention{KeepLast: 10, KeepWeekly: 4}, true), []string{"forget", "--json", "--group-by", "", "--keep-last", "10", "--keep-weekly", "4", "--prune"}; !reflect.DeepEqual(got, want) {
		t.Errorf("forgetArgs: %q", got)
	}
	if got, want := restoreArgs("abcdef12", []string{"world", "we*ird[1].txt"}), []string{"restore", "abcdef12", "--json", "--target", "/restore", "--include", "/home/container/world", "--include", `/home/container/we\*ird\[1\].txt`}; !reflect.DeepEqual(got, want) {
		t.Errorf("restoreArgs: %q", got)
	}
	if got := lsArgs("abcdef12", "."); !reflect.DeepEqual(got, []string{"ls", "--json", "--no-lock", "abcdef12", "/home/container"}) {
		t.Errorf("lsArgs root: %q", got)
	}
	if got := lsArgs("abcdef12", "world"); got[len(got)-1] != "/home/container/world" {
		t.Errorf("lsArgs: %q", got)
	}
}

func TestResticContainer(t *testing.T) {
	repo := ResticRepo{S3: S3{Endpoint: "https://s3.node1.test", Bucket: "bk", Region: "eu-west-1", AccessKey: "AKTEST", SecretKey: "secret-key-1", PathStyle: true}, Password: "repo-password-0123456789"}
	labels := map[string]string{"panel.managed": "true", "panel.instance": "t", "panel.role": "install", "panel.server_uuid": testUUID}
	cfg, err := resticContainer(resticSpec{UUID: testUUID, Image: DefaultResticImage, Repo: repo, Args: []string{"snapshots", "--json"},
		Mounts: []engine.Mount{{Source: "/data/v", Target: "/home/container", ReadOnly: true}}, Cache: "/data/cache", Network: "panel-site-" + testUUID, UID: 1000, GID: 1000, Labels: labels})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.Name, "panel-"+testUUID+"-restic-") || cfg.Image != DefaultResticImage || cfg.User != "1000:1000" || !cfg.ReadOnlyRootfs || cfg.NetworkMode != "panel-site-"+testUUID {
		t.Errorf("config: %+v", cfg)
	}
	if !strings.Contains(DefaultResticImage, "@sha256:") {
		t.Error("image niet op digest gepind")
	}
	if !reflect.DeepEqual(cfg.CapDrop, []string{"ALL"}) || !reflect.DeepEqual(cfg.SecurityOpt, []string{"no-new-privileges"}) || cfg.Resources.Memory == 0 || cfg.Resources.PidsLimit == 0 {
		t.Errorf("beveiliging: %+v", cfg)
	}
	if !reflect.DeepEqual(cfg.Labels, labels) {
		t.Errorf("labels: %v", cfg.Labels)
	}
	wantCmd := []string{"--retry-lock", "1m", "-o", "s3.bucket-lookup=path", "-o", "s3.region=eu-west-1", "snapshots", "--json"}
	if !reflect.DeepEqual(cfg.Cmd, wantCmd) {
		t.Errorf("cmd: %q", cfg.Cmd)
	}
	// Geheimen alleen in de omgeving, nooit in de argumenten.
	joined := strings.Join(cfg.Cmd, " ")
	for _, s := range []string{repo.Password, repo.S3.SecretKey, repo.S3.AccessKey} {
		if strings.Contains(joined, s) {
			t.Errorf("geheim %q in cmd", s)
		}
	}
	env := strings.Join(cfg.Env, "\n")
	for _, want := range []string{"RESTIC_REPOSITORY=s3:https://s3.node1.test/bk/restic/" + testUUID, "RESTIC_PASSWORD=" + repo.Password, "AWS_ACCESS_KEY_ID=AKTEST", "AWS_SECRET_ACCESS_KEY=secret-key-1", "AWS_DEFAULT_REGION=eu-west-1", "RESTIC_CACHE_DIR=/cache"} {
		if !strings.Contains(env, want) {
			t.Errorf("env mist %q", want)
		}
	}
	mounts := map[string]engine.Mount{}
	for _, m := range cfg.Mounts {
		mounts[m.Target] = m
	}
	if !mounts["/home/container"].ReadOnly || mounts["/cache"].Source != "/data/cache" || mounts["/cache"].ReadOnly {
		t.Errorf("mounts: %+v", cfg.Mounts)
	}
	// Virtual-host-stijl.
	repo.S3.PathStyle = false
	cfg, _ = resticContainer(resticSpec{UUID: testUUID, Image: "x", Repo: repo})
	if !strings.Contains(strings.Join(cfg.Cmd, " "), "s3.bucket-lookup=dns") {
		t.Errorf("dns: %q", cfg.Cmd)
	}
	// Lokale repository (tests): geen S3-gegevens.
	cfg, _ = resticContainer(resticSpec{UUID: testUUID, Image: "x", Repo: repo, LocalRepo: "/tmp/r"})
	if strings.Contains(strings.Join(cfg.Env, " "), "AWS_") || !strings.Contains(strings.Join(cfg.Env, " "), "RESTIC_REPOSITORY=/repo") {
		t.Errorf("lokaal: %q", cfg.Env)
	}
}

func TestRepoValidate(t *testing.T) {
	good := ResticRepo{S3: S3{Endpoint: "https://x", Bucket: "bk"}, Password: strings.Repeat("p", 32)}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, r := range []ResticRepo{
		{S3: good.S3, Password: "short"},
		{S3: good.S3, Password: strings.Repeat("p", 20) + "\n"},
		{S3: S3{Bucket: "bk"}, Password: good.Password},
	} {
		if r.Validate() == nil {
			t.Errorf("geaccepteerd: %+v", r.S3)
		}
	}
}

func TestParseOutput(t *testing.T) {
	var status, summary resticMsg
	var nodes []LsEntry
	col := &lineCollector{fn: func(m resticMsg) {
		switch m.MessageType {
		case "status":
			status = m
		case "summary":
			summary = m
		}
		if e, ok := lsEntry(m, "/home/container/world"); ok {
			nodes = append(nodes, e)
		}
	}}
	out := `{"message_type":"status","percent_done":0.5,"total_files":4,"files_done":2,"total_bytes":1000,"bytes_done":500}
Fatal: something on stderr
{"message_type":"summary","files_new":4,"data_added":2656,"data_added_packed":2007,"total_files_processed":4,"total_bytes_processed":10,"snapshot_id":"ba957e56448decc8f96a2e6942a4dfa657a47b1bb809fab4731123b596fc74ac"}
{"message_type":"error","error":{"message":"permission denied"},"during":"archival","item":"/home/container/x"}
{"time":"2026-11-28T15:53:20Z","paths":["/home/container"],"hostname":"panel","id":"3de189f5","short_id":"3de189f5","message_type":"snapshot","struct_type":"snapshot"}
{"name":"world","type":"dir","path":"/home/container/world","message_type":"node","struct_type":"node"}
{"name":"level.dat","type":"file","path":"/home/container/world/level.dat","size":2,"mtime":"2026-11-28T15:53:14.725556633Z","message_type":"node","struct_type":"node"}
{"name":"r.0.0.mca","type":"file","path":"/home/container/world/region/r.0.0.mca","size":2,"message_type":"node","struct_type":"node"}
{"name":"region","type":"dir","path":"/home/container/world/region","message_type":"node","struct_type":"node"}
{"name":"dev","type":"chardev","path":"/home/container/world/dev","message_type":"node","struct_type":"node"}
{"message_type":"exit_error","code":1,"message":"Fatal: unable to save snapshot"}
`
	if err := col.read(strings.NewReader(out)); err != nil {
		t.Fatal(err)
	}
	if status.TotalBytes != 1000 || status.BytesDone != 500 {
		t.Errorf("status: %+v", status)
	}
	if summary.SnapshotID[:8] != "ba957e56" || summary.DataAddedPacked != 2007 || summary.TotalBytesProcessed != 10 {
		t.Errorf("summary: %+v", summary)
	}
	if len(nodes) != 3 || nodes[0].Path != "world/level.dat" || nodes[0].Size != 2 || nodes[0].MTime.IsZero() || nodes[1].Type != "dir" || nodes[1].Path != "world/region" || nodes[2].Type != "other" {
		t.Errorf("ls: %+v", nodes)
	}
	msg := col.message()
	for _, want := range []string{"Fatal: something on stderr", "/home/container/x: permission denied", "unable to save snapshot"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message mist %q: %s", want, msg)
		}
	}
	ids, err := forgotten(`[{"tags":null,"host":"","paths":null,"keep":[{"id":"3de1"}],"remove":[{"id":"ba95"},{"id":"cc01"}],"reasons":[]}]`)
	if err != nil || !reflect.DeepEqual(ids, []string{"ba95", "cc01"}) {
		t.Errorf("forgotten: %v %v", ids, err)
	}
	if ids, err := forgotten(`[{"keep":[],"remove":null}]`); err != nil || len(ids) != 0 || ids == nil {
		t.Errorf("forgotten leeg: %v %v", ids, err)
	}
}

func TestScrubRepo(t *testing.T) {
	r := ResticRepo{S3: S3{AccessKey: "AKTEST", SecretKey: "secret-key-1"}, Password: "repo-password-0123456789"}
	got := scrubRepo("bad repo-password-0123456789 secret-key-1 AKTEST", r, nil)
	if strings.Contains(got, "repo-password") || strings.Contains(got, "secret-key") || strings.Contains(got, "AKTEST") {
		t.Error(got)
	}
}

func TestValidateRestore(t *testing.T) {
	base := ResticRestoreRequest{ResticRepo: ResticRepo{S3: S3{Endpoint: "https://x", Bucket: "bk"}, Password: strings.Repeat("p", 32)}, SnapshotID: "abcdef12"}
	r := base
	r.Paths = []string{"/world/", "world", "plugins/x.jar"}
	r.Destination = "/restore-2026-11-28/"
	if err := validateRestore(&r); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.Paths, []string{"world", "plugins/x.jar"}) || r.Destination != "restore-2026-11-28" {
		t.Errorf("schoon: %q %q", r.Paths, r.Destination)
	}
	for _, mut := range []func(*ResticRestoreRequest){
		func(r *ResticRestoreRequest) { r.SnapshotID = "../x" },
		func(r *ResticRestoreRequest) { r.Paths = []string{"../etc/passwd"} },
		func(r *ResticRestoreRequest) { r.Paths = []string{"/"} },
		func(r *ResticRestoreRequest) { r.Paths = []string{"a"}; r.Destination = "../x" },
		func(r *ResticRestoreRequest) { r.Paths = []string{"a"}; r.Destination = "/" },
		func(r *ResticRestoreRequest) { r.Destination = "sub" }, // bestemming zonder paden
		func(r *ResticRestoreRequest) { r.Paths = make([]string, MaxRestorePaths+1) },
	} {
		r := base
		mut(&r)
		if err := validateRestore(&r); err == nil {
			t.Errorf("geaccepteerd: %+v %q", r.Paths, r.Destination)
		}
	}
}

func TestCopyTree(t *testing.T) {
	srcDir, dstDir := t.TempDir(), t.TempDir()
	mk := func(base, rel, content string) {
		p := filepath.Join(base, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	mk(srcDir, "world/level.dat", "new")
	mk(srcDir, "world/region/r.0.0.mca", "region")
	_ = os.Symlink("level.dat", filepath.Join(srcDir, "world/link"))
	mk(dstDir, "world/level.dat", "old")
	mk(dstDir, "world/keep.txt", "keep")
	mk(dstDir, "world/region", "was a file") // ander soort item: wordt vervangen
	_ = os.Symlink("/etc", filepath.Join(dstDir, "world/link"))
	src, _ := os.OpenRoot(srcDir)
	dst, _ := os.OpenRoot(dstDir)
	defer src.Close()
	defer dst.Close()
	uid, gid := os.Getuid(), os.Getgid()
	if err := copyTree(src, "world", dst, "world", uid, gid); err != nil {
		t.Fatal(err)
	}
	read := func(rel string) string { b, _ := os.ReadFile(filepath.Join(dstDir, rel)); return string(b) }
	if read("world/level.dat") != "new" || read("world/keep.txt") != "keep" || read("world/region/r.0.0.mca") != "region" {
		t.Errorf("inhoud: %q %q %q", read("world/level.dat"), read("world/keep.txt"), read("world/region/r.0.0.mca"))
	}
	if l, _ := os.Readlink(filepath.Join(dstDir, "world/link")); l != "level.dat" {
		t.Errorf("symlink: %q", l)
	}
	// Naar een submap.
	if err := copyTree(src, "world/region", dst, "restore-x/world/region", uid, gid); err != nil {
		t.Fatal(err)
	}
	if read("restore-x/world/region/r.0.0.mca") != "region" {
		t.Error("submap")
	}
	// Een symlink in het doel die naar buiten wijst, wordt niet gevolgd.
	outside := t.TempDir()
	_ = os.Symlink(outside, filepath.Join(dstDir, "escape"))
	if err := copyTree(src, "world/level.dat", dst, "escape/level.dat", uid, gid); err == nil {
		t.Error("schrijven via een symlink naar buiten lukte")
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Errorf("bestanden buiten de root: %v", ents)
	}
}

func TestForgetArrayAmidPruneOutput(t *testing.T) {
	var arrays []string
	col := &lineCollector{fn: func(m resticMsg) {
		if m.MessageType == "array" {
			arrays = append(arrays, m.Message)
		}
	}}
	_ = col.read(strings.NewReader("[{\"keep\":[],\"remove\":[{\"id\":\"ab\"}]}]\nloading indexes...\n[0:00] 100.00%  1 / 1 snapshots\ndone\n"))
	if len(arrays) != 1 {
		t.Fatalf("arrays: %q", arrays)
	}
}
