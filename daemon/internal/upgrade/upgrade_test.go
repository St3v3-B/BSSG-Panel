package upgrade

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type call struct {
	name string
	args []string
}

func newSvc(t *testing.T, run Runner) (*Service, string, string) {
	t.Helper()
	repo, up := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, "deploy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "deploy", "upgrade.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Service{RepoDir: repo, UpgradeDir: up, Run: run, Now: func() time.Time { return time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC) }}, repo, up
}

func TestValidRef(t *testing.T) {
	for ref, want := range map[string]bool{
		"origin/main": true, "abcdef1": true, "0123456789abcdef0123456789abcdef01234567": true,
		"": false, "abcdef": false, "ABCDEF1": false, "main": false, "origin/main; reboot": false, "origin/other": false,
		"abcdef1 --foo": false, "-abcdef1": false, "0123456789abcdef0123456789abcdef012345678": false, "abcdef1\n": false,
	} {
		if got := ValidRef(ref); got != want {
			t.Errorf("ValidRef(%q) = %v, want %v", ref, got, want)
		}
	}
}

func TestStartInvokesSystemdRun(t *testing.T) {
	var calls []call
	s, repo, up := newSvc(t, func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, call{name, args})
		return "", nil
	})
	st, err := s.Start(context.Background(), "abcdef12")
	if err != nil {
		t.Fatal(err)
	}
	if st.Unit != "panel-upgrade-20261127T100000Z" {
		t.Fatalf("unit %q", st.Unit)
	}
	if len(calls) != 1 || calls[0].name != "systemd-run" {
		t.Fatalf("calls %+v", calls)
	}
	joined := strings.Join(calls[0].args, " ")
	for _, want := range []string{"--unit panel-upgrade-20261127T100000Z", "--collect", "--working-directory=" + repo, "PANEL_UPGRADE_DIR=" + up, repo + "/deploy/upgrade.sh --ref abcdef12"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %q", want, joined)
		}
	}
	// default ref
	calls = nil
	if _, err := s.Start(context.Background(), ""); err != nil || !strings.HasSuffix(strings.Join(calls[0].args, " "), "--ref origin/main") {
		t.Fatalf("default ref: %v %+v", err, calls)
	}
}

func TestStartRefusals(t *testing.T) {
	ran := false
	s, _, up := newSvc(t, func(context.Context, string, ...string) (string, error) { ran = true; return "", nil })
	if _, err := s.Start(context.Background(), "main; rm -rf /"); !errors.Is(err, ErrBadRef) {
		t.Fatalf("bad ref: %v", err)
	}
	// running with a live pid
	os.WriteFile(filepath.Join(up, "status.json"), []byte(`{"state":"running","pid":4242}`), 0o644)
	s.PidAlive = func(int) bool { return true }
	if _, err := s.Start(context.Background(), ""); !errors.Is(err, ErrRunning) {
		t.Fatalf("running: %v", err)
	}
	// stale status (process gone) does not block
	s.PidAlive = func(int) bool { return false }
	if _, err := s.Start(context.Background(), ""); err != nil {
		t.Fatalf("stale: %v", err)
	}
	// not local
	if _, err := (&Service{}).Start(context.Background(), ""); !errors.Is(err, ErrNotLocal) {
		t.Fatalf("not local: %v", err)
	}
	if !ran {
		t.Fatal("systemd-run should have run for the stale case")
	}
}

func TestStatus(t *testing.T) {
	var fetched bool
	s, _, up := newSvc(t, func(_ context.Context, name string, args ...string) (string, error) {
		j := strings.Join(args, " ")
		switch {
		case strings.Contains(j, "fetch"):
			fetched = true
			return "", nil
		case strings.HasSuffix(j, "HEAD..origin/main"):
			return "bbb\x1f2026-11-27T10:00:00+01:00\x1fsecond\x1fSteve\naaa\x1f\x1ffirst\x1f\n", nil
		default:
			return "ccc\x1f2026-11-26T10:00:00+01:00\x1fcurrent\x1fSteve\n", nil
		}
	})
	os.WriteFile(filepath.Join(up, "status.json"), []byte(`{"state":"success","from":"a","to":"b"}`), 0o644)
	os.WriteFile(filepath.Join(up, "upgrade-20261126T000000Z.log"), []byte("old\n"), 0o644)
	os.WriteFile(filepath.Join(up, "upgrade-20261127T000000Z.log"), []byte("l1\nl2\n"), 0o644)
	st, err := s.Status(context.Background(), true)
	if err != nil || !fetched {
		t.Fatalf("%v fetched=%v", err, fetched)
	}
	if st.Current.SHA != "ccc" || len(st.Commits) != 2 || st.Commits[0].Message != "second" || st.Commits[1].Date != nil {
		t.Fatalf("%+v", st)
	}
	if !strings.Contains(string(st.Upgrade), `"success"`) || st.LogTail != "l1\nl2" || st.FetchError != nil {
		t.Fatalf("%+v", st)
	}
	fetched = false
	if _, err := s.Status(context.Background(), false); err != nil || fetched {
		t.Fatal("fetch=0 must not fetch")
	}
}

func TestStatusFetchError(t *testing.T) {
	s, _, _ := newSvc(t, func(_ context.Context, _ string, args ...string) (string, error) {
		if strings.Contains(strings.Join(args, " "), "fetch") {
			return "", errors.New("network down")
		}
		return "ccc\x1f\x1fcur\x1f\n", nil
	})
	st, err := s.Status(context.Background(), true)
	if err != nil || st.FetchError == nil || !strings.Contains(*st.FetchError, "network down") || st.Current.SHA != "ccc" {
		t.Fatalf("%v %+v", err, st)
	}
}
