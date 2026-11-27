// Package selfupdate vervangt de daemon-binary door de huidige van het panel (/join/daemon/<arch>), na een
// sha256-controle. De aanroeper herstart het proces (systemd: Restart=always).
package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Updater haalt de binary van PanelURL.
type Updater struct {
	PanelURL string
	// Exe is het pad van de draaiende binary (standaard os.Executable()).
	Exe  string
	Arch string // standaard runtime.GOARCH
	HTTP *http.Client
}

const maxBinary = 200 << 20

func (u *Updater) client() *http.Client {
	if u.HTTP != nil {
		return u.HTTP
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

func (u *Updater) get(ctx context.Context, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(u.PanelURL, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.client().Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("panel gave HTTP %d for %s", resp.StatusCode, path)
	}
	return resp, nil
}

func fileSum(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Run downloadt en installeert. changed=false: de binary is al de huidige. Bij een fout blijft de oude binary staan.
func (u *Updater) Run(ctx context.Context) (changed bool, err error) {
	exe, arch := u.Exe, u.Arch
	if exe == "" {
		if exe, err = os.Executable(); err != nil {
			return false, err
		}
	}
	if arch == "" {
		arch = runtime.GOARCH
	}
	if arch != "amd64" && arch != "arm64" {
		return false, fmt.Errorf("unsupported architecture %s", arch)
	}
	r, err := u.get(ctx, "/join/daemon/"+arch+".sha256")
	if err != nil {
		return false, err
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 256))
	r.Body.Close()
	want := strings.ToLower(strings.TrimSpace(strings.Fields(string(b) + " ")[0]))
	if len(want) != 64 {
		return false, errors.New("panel served an invalid sha256")
	}
	if cur, err := fileSum(exe); err == nil && cur == want {
		return false, nil
	}
	resp, err := u.get(ctx, "/join/daemon/"+arch)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	tmp, err := os.CreateTemp(filepath.Dir(exe), ".panel-daemon.update.*")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, maxBinary+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return false, err
	}
	if n > maxBinary {
		return false, errors.New("binary too large")
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return false, fmt.Errorf("sha256 mismatch (got %s, want %s)", got, want)
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return false, err
	}
	// rename werkt ook als de oude binary draait.
	if err := os.Rename(tmp.Name(), exe); err != nil {
		return false, err
	}
	return true, nil
}
