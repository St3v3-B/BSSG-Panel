package proxy

// Controleert dat de door het panel beheerde bestanden (php/00-panel.ini, nginx/00-panel.conf,
// php/.disabled-extensions; zie apps/web/server/lib/php-settings.ts) echt effect hebben in een
// PHP 8.3-sitecontainer: ini-waarden (FPM en CLI), uitgezette extensie, OPcache uit en de
// nginx-uploadlimiet die meebeweegt met upload_max_filesize.

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"os/exec"
	"strings"
	"testing"
)

const managedPhpIni = `; Managed by the panel (Settings > PHP). Do not edit: changes are overwritten when the settings are saved.
; Put your own settings in another file in this folder, for example 50-custom.ini.
memory_limit = 200M
upload_max_filesize = 4M
post_max_size = 4M
max_execution_time = 90
max_input_vars = 5000
display_errors = On
date.timezone = UTC
opcache.enable = 0
`

const settingsInfoPage = `<?php
header('Content-Type: text/plain');
foreach (['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'display_errors', 'date.timezone', 'opcache.enable'] as $k)
  echo $k, '=', ini_get($k), "\n";
echo 'tz=', date_default_timezone_get(), "\n";
echo 'exif=', extension_loaded('exif') ? 'ja' : 'nee', ' gd=', extension_loaded('gd') ? 'ja' : 'nee', "\n";
`

func TestDockerPhpManagedSettings(t *testing.T) {
	e := setupCaddy(t)
	ctx := context.Background()
	c := e.router()
	w := loadWebTemplate(t, "php-8.3")
	s := e.runSite(t, w, map[string]string{
		"public/info.php":          settingsInfoPage,
		"public/upload.php":        phpUploadPage,
		"public/uploads/.keep":     "",
		"php/00-panel.ini":         managedPhpIni,
		"nginx/00-panel.conf":      "# Managed by the panel\nclient_max_body_size 4M;\n",
		"php/.disabled-extensions": "exif\n",
	})
	host := w.Slug + ".site.test"
	if err := c.SetRoute(ctx, Route{Host: host, ServerUUID: w.Slug, Upstream: Upstream{Container: s.name, Network: s.network, Port: w.HTTPPort}}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.RemoveRoute(ctx, host); e.stopSite(t, w, s) }()

	e.get(t, "https://"+host+"/info.php", bodyContains(
		"memory_limit=200M", "upload_max_filesize=4M", "post_max_size=4M", "max_execution_time=90", "max_input_vars=5000",
		"display_errors=1", "date.timezone=UTC", "opcache.enable=0", "tz=UTC", "exif=nee gd=ja"))

	// De CLI (cronjobs via exec) ziet dezelfde waarden en dezelfde uitgezette extensie.
	out, err := exec.Command("docker", "exec", "--user", "1000:1000", s.name, "php", "-r",
		"echo ini_get('memory_limit'), ' ', ini_get('post_max_size'), ' ', ini_get('date.timezone'), ' ', extension_loaded('exif') ? 'exif' : 'noexif', ' ', extension_loaded('mysqli') ? 'mysqli' : 'nomysqli';").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "200M 4M UTC noexif mysqli" {
		t.Fatalf("php CLI: %v %q", err, out)
	}

	upload := func(size int) (int, string) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("f", "x.bin")
		_, _ = fw.Write(bytes.Repeat([]byte("a"), size))
		_ = mw.Close()
		resp, err := e.client.Post("https://"+host+"/upload.php", mw.FormDataContentType(), &buf)
		if err != nil {
			// nginx weigert een te grote body soms al terwijl de client nog schrijft; dan ziet de
			// client "broken pipe"/"connection reset" in plaats van het 413-antwoord. Dat is ook
			// een weigering.
			if es := err.Error(); strings.Contains(es, "broken pipe") || strings.Contains(es, "connection reset") {
				return 413, ""
			}
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	// Onder de limiet lukt het; erboven weigert nginx (client_max_body_size volgt upload_max_filesize).
	if code, body := upload(3 << 20); code != 200 || !strings.Contains(body, "err=0 moved=ja") {
		t.Errorf("upload 3 MB: %d %q", code, body)
	}
	if code, _ := upload(5 << 20); code != 413 {
		t.Errorf("upload 5 MB: status %d, want 413", code)
	}
}
