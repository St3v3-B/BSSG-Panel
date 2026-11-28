package mail

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ComposeRunner voert `docker <args>` uit met extra omgeving en geeft stdout.
type ComposeRunner func(ctx context.Context, env []string, args ...string) (string, error)

// ExecCompose is de echte ComposeRunner.
func ExecCompose(ctx context.Context, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Env = append(os.Environ(), env...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("docker %s: %w: %s", strings.Join(args[:min(len(args), 8)], " "), err, trim(errb.String()))
	}
	return out.String(), nil
}

// composeBase: zelfde bestanden en env-bestand als install.sh.
func (s *Service) composeBase() ([]string, []string, error) {
	if s.cfg.RepoDir == "" {
		return nil, nil, ErrNoCompose
	}
	file := filepath.Join(s.cfg.RepoDir, "deploy", "docker-compose.yml")
	if _, err := os.Stat(file); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrNoCompose, err)
	}
	args := []string{"compose", "--env-file", s.cfg.EnvFile, "-f", file}
	if strings.EqualFold(s.cfg.HTTPMode, "npm") {
		if npm := filepath.Join(s.cfg.RepoDir, "deploy", "docker-compose.npm.yml"); fileExists(npm) {
			args = append(args, "-f", npm)
		}
	}
	// COMPOSE_PROFILES leeg: alleen het expliciete --profile telt, zodat we precies weten welke diensten erbij komen.
	env := []string{"PANEL_ENV_FILE=" + s.cfg.EnvFile, "COMPOSE_PROFILES="}
	return args, env, nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func (s *Service) compose(ctx context.Context, env []string, args ...string) (string, error) {
	run := s.Compose
	if run == nil {
		run = ExecCompose
	}
	return run(ctx, env, args...)
}

// mailServices zijn de compose-diensten die alleen met het mailprofiel bestaan (zo raken up/stop nooit de rest
// van de stack).
func (s *Service) mailServices(ctx context.Context) ([]string, []string, []string, error) {
	base, env, err := s.composeBase()
	if err != nil {
		return nil, nil, nil, err
	}
	all, err := s.compose(ctx, env, append(append([]string{}, base...), "--profile", s.cfg.ComposeProfile, "config", "--services")...)
	if err != nil {
		return nil, nil, nil, err
	}
	plain, err := s.compose(ctx, env, append(append([]string{}, base...), "config", "--services")...)
	if err != nil {
		return nil, nil, nil, err
	}
	have := map[string]bool{}
	for _, l := range strings.Fields(plain) {
		have[l] = true
	}
	var svc []string
	for _, l := range strings.Fields(all) {
		if !have[l] {
			svc = append(svc, l)
		}
	}
	sort.Strings(svc)
	if len(svc) == 0 {
		return nil, nil, nil, fmt.Errorf("compose profile %q has no services", s.cfg.ComposeProfile)
	}
	return base, env, svc, nil
}

// Enable start de mailstack (`docker compose --profile mail up -d <maildiensten>`). Kan minuten duren (build/pull).
func (s *Service) Enable(ctx context.Context) error {
	if s.Hostname() == "" {
		return ErrNotConfigured
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	// Los van de HTTP-aanvraag: een afgebroken verbinding laat compose niet halverwege stoppen.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Minute)
	defer cancel()
	base, env, svc, err := s.mailServices(ctx)
	if err != nil {
		return err
	}
	args := append(append(base, "--profile", s.cfg.ComposeProfile, "up", "-d"), svc...)
	_, err = s.compose(ctx, env, args...)
	if err == nil {
		s.log.Info("mail stack enabled", "services", svc)
	}
	return err
}

// Disable stopt de mailstack (`docker compose --profile mail stop <maildiensten>`); data en containers blijven.
func (s *Service) Disable(ctx context.Context) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
	defer cancel()
	base, env, svc, err := s.mailServices(ctx)
	if err != nil {
		return err
	}
	_, err = s.compose(ctx, env, append(append(base, "--profile", s.cfg.ComposeProfile, "stop"), svc...)...)
	if err == nil {
		s.log.Info("mail stack stopped", "services", svc)
	}
	return err
}
