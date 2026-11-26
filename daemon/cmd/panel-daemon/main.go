// Command panel-daemon is de node-daemon. Het contract staat in packages/api/openapi.yaml,
// de taak in daemon/CLAUDE.md.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"reflect"
	"syscall"
	"time"

	"panel/daemon/internal/config"
	"panel/daemon/internal/daemon"
	"panel/daemon/internal/engine"
	"panel/daemon/proxy"
)

var version = "0.1.0-dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	level := slog.LevelInfo
	if os.Getenv("DAEMON_DEBUG") == "1" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if err := run(log); err != nil {
		log.Error("daemon stopt", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	eng, err := engine.NewDocker()
	if err != nil {
		return fmt.Errorf("docker: %w", err)
	}
	var router proxy.Router
	if cfg.CaddyAdminURL == "" {
		log.Warn("CADDY_ADMIN_URL leeg: routes gaan naar een fake router")
		router = proxy.NewFake()
	} else {
		pc := proxy.Config{AdminURL: cfg.CaddyAdminURL, CaddyContainer: cfg.CaddyContainer, Instance: cfg.Instance}
		setTLSAddr(&pc, cfg.CaddyTLSAddr)
		router, err = proxy.NewCaddy(pc)
		if err != nil {
			return fmt.Errorf("caddy: %w", err)
		}
	}
	d, err := daemon.New(cfg, daemon.Deps{Engine: eng, Router: router, Log: log, Version: version})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	err = d.Start(startCtx)
	cancel()
	if err != nil {
		return err
	}
	<-ctx.Done()
	log.Info("daemon stopt; containers blijven draaien")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	d.Shutdown(shutCtx)
	return nil
}

// setTLSAddr vult proxy.Config.TLSAddr (CADDY_TLS_ADDR). Via reflect zodat dit bouwt met
// en zonder het veld (het staat in main, nog niet in deze branch); na de merge kan dit
// gewoon `pc.TLSAddr = addr` worden.
func setTLSAddr(pc *proxy.Config, addr string) {
	if f := reflect.ValueOf(pc).Elem().FieldByName("TLSAddr"); f.IsValid() && f.Kind() == reflect.String {
		f.SetString(addr)
	}
}
