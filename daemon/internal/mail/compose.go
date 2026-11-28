package mail

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// ScriptRunner voert een programma uit met extra omgeving en geeft stdout, stderr en de exitcode (-1 als het
// programma niet startte; err is dan gezet).
type ScriptRunner func(ctx context.Context, env []string, name string, args ...string) (stdout, stderr string, code int, err error)

// ExecScript is de echte ScriptRunner.
func ExecScript(ctx context.Context, env []string, name string, args ...string) (string, string, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), errb.String(), ee.ExitCode(), nil
	}
	if err != nil {
		return out.String(), errb.String(), -1, err
	}
	return out.String(), errb.String(), 0, nil
}

// mailScript is deploy/mail.sh in de panel-checkout.
func (s *Service) mailScript() (string, error) {
	if s.cfg.RepoDir == "" {
		return "", ErrNoCompose
	}
	p := filepath.Join(s.cfg.RepoDir, "deploy", "mail.sh")
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		return "", fmt.Errorf("%w: %s missing", ErrNoCompose, p)
	}
	return p, nil
}

// runMailScript draait `deploy/mail.sh <action>` (argv, PANEL_ENV_FILE in de omgeving), los van de
// HTTP-aanvraag: een afgebroken verbinding laat het script niet halverwege stoppen.
// Exitcodes van het script: 0 ok, 3 niet geconfigureerd (MAIL_HOSTNAME of MAIL_DB_PASSWORD leeg), anders fout.
func (s *Service) runMailScript(ctx context.Context, action string, timeout time.Duration) error {
	script, err := s.mailScript()
	if err != nil {
		return err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	run := s.Script
	if run == nil {
		run = ExecScript
	}
	_, stderr, code, err := run(ctx, []string{"PANEL_ENV_FILE=" + s.cfg.EnvFile}, script, action)
	switch {
	case err != nil:
		return fmt.Errorf("mail.sh %s: %w", action, err)
	case code == 3:
		return fmt.Errorf("%w: %s", ErrNotConfigured, trim(stderr))
	case code != 0:
		if ctx.Err() != nil {
			return fmt.Errorf("mail.sh %s: %w", action, ctx.Err())
		}
		return fmt.Errorf("mail.sh %s exited with %d: %s", action, code, trim(stderr))
	}
	s.log.Info("mail stack "+action+"d", "script", script)
	return nil
}

// Enable zet de mailstack aan via `deploy/mail.sh enable` (COMPOSE_PROFILES += mail in panel.env, bouwen en
// starten met --no-deps, Caddy alleen opnieuw als zijn mailsite wijzigde). Kan minuten duren (build/pull).
func (s *Service) Enable(ctx context.Context) error {
	if s.Hostname() == "" {
		return ErrNotConfigured
	}
	return s.runMailScript(ctx, "enable", 20*time.Minute)
}

// Disable zet de mailstack uit via `deploy/mail.sh disable` (containers stoppen; data blijft in de volumes).
func (s *Service) Disable(ctx context.Context) error {
	return s.runMailScript(ctx, "disable", 5*time.Minute)
}
