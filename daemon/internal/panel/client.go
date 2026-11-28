// Package panel is de client voor panel-remote.yaml (daemon → panel).
package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// JWK is één sleutel uit GET /api/remote/jwt-key.
type JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
}

// StatusError is een HTTP-fout van het panel.
type StatusError struct {
	Code int
	Body string
}

func (e *StatusError) Error() string { return fmt.Sprintf("panel: HTTP %d: %s", e.Code, e.Body) }

// Client praat met het panel. Alle Report-methodes zijn asynchroon en proberen het
// opnieuw met backoff (max MaxRetry) bij 5xx of een netwerkfout.
type Client struct {
	BaseURL  string
	Token    string
	HTTP     *http.Client
	Log      *slog.Logger
	MaxRetry time.Duration
	// MinBackoff/MaxBackoff voor herhalingen (tests zetten ze laag).
	MinBackoff, MaxBackoff time.Duration

	mu     sync.Mutex
	status map[string]*statusSlot
	wg     sync.WaitGroup
}

type statusSlot struct {
	pending string
	running bool
}

// New maakt een client met redelijke standaardwaarden.
func New(baseURL, token string, log *slog.Logger) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		Token:      token,
		HTTP:       &http.Client{Timeout: 15 * time.Second},
		Log:        log,
		MaxRetry:   10 * time.Minute,
		MinBackoff: time.Second,
		MaxBackoff: time.Minute,
		status:     map[string]*statusSlot{},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return &StatusError{Code: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return nil
}

func retryable(err error) bool {
	if se, ok := err.(*StatusError); ok {
		return se.Code >= 500
	}
	return true
}

// retry voert fn uit tot hij lukt, een niet-herhaalbare fout geeft, of MaxRetry voorbij is.
func (c *Client) retry(ctx context.Context, what string, fn func(context.Context) error) error {
	deadline := time.Now().Add(c.MaxRetry)
	wait := c.MinBackoff
	for {
		err := fn(ctx)
		if err == nil {
			return nil
		}
		if !retryable(err) || time.Now().Add(wait).After(deadline) {
			c.Log.Warn("panel call failed", "call", what, "err", err)
			return err
		}
		c.Log.Debug("panel-aanroep, opnieuw", "call", what, "err", err, "wait", wait)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		wait *= 2
		if wait > c.MaxBackoff {
			wait = c.MaxBackoff
		}
	}
}

// JWKS haalt de publieke sleutels op (synchroon, geen retry).
func (c *Client) JWKS(ctx context.Context) ([]JWK, error) {
	var out struct {
		Keys []JWK `json:"keys"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/remote/jwt-key", nil, &out); err != nil {
		return nil, err
	}
	return out.Keys, nil
}

// Hello meldt de daemon aan (asynchroon met retry).
func (c *Client) Hello(version, diskQuotaMode string, hasMariaDB bool) {
	c.async("hello", func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, "/api/remote/node/hello", map[string]any{"version": version, "disk_quota_mode": diskQuotaMode, "has_mariadb": hasMariaDB}, nil)
	})
}

// HelloNow meldt de daemon synchroon (zonder retry); de fout is die van het panel of het netwerk.
func (c *Client) HelloNow(ctx context.Context, version, diskQuotaMode string, hasMariaDB bool) error {
	return c.do(ctx, http.MethodPost, "/api/remote/node/hello", map[string]any{"version": version, "disk_quota_mode": diskQuotaMode, "has_mariadb": hasMariaDB}, nil)
}

// ImageSettings haalt de globale instellingen voor image-updates op.
func (c *Client) ImageSettings(ctx context.Context) (ImageSettings, error) {
	var out ImageSettings
	err := c.do(ctx, http.MethodGet, "/api/remote/settings/image-updates", nil, &out)
	return out, err
}

// ReportImages meldt het resultaat van een image-controle (asynchroon met retry).
func (c *Client) ReportImages(items []ImageStatus) {
	if items == nil {
		items = []ImageStatus{} // JSON [] i.p.v. null: het panel eist een lijst
	}
	c.async("images", func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, "/api/remote/node/images", map[string]any{"servers": items}, nil)
	})
}

// ReportImageUpdate meldt dat een image-update is toegepast of mislukt.
func (c *Client) ReportImageUpdate(uuid string, r ImageUpdateResult) {
	c.async("image-update "+uuid, func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, "/api/remote/servers/"+uuid+"/image-update", r, nil)
	})
}

// ReportInstall meldt het resultaat van een installatie (asynchroon met retry).
func (c *Client) ReportInstall(uuid string, ok bool, errMsg string) {
	body := map[string]any{"successful": ok, "error": nil}
	if errMsg != "" {
		body["error"] = errMsg
	}
	c.async("install "+uuid, func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, "/api/remote/servers/"+uuid+"/install", body, nil)
	})
}

// ReportStatus meldt een statuswijziging. Per server loopt er hooguit één verzoek;
// komt er intussen een nieuwere status, dan wordt alleen die nog verstuurd.
func (c *Client) ReportStatus(uuid, state string) {
	c.mu.Lock()
	slot := c.status[uuid]
	if slot == nil {
		slot = &statusSlot{}
		c.status[uuid] = slot
	}
	slot.pending = state
	if slot.running {
		c.mu.Unlock()
		return
	}
	slot.running = true
	c.mu.Unlock()
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		for {
			c.mu.Lock()
			st := slot.pending
			if st == "" {
				slot.running = false
				c.mu.Unlock()
				return
			}
			slot.pending = ""
			c.mu.Unlock()
			_ = c.retry(context.Background(), "status "+uuid, func(ctx context.Context) error {
				c.mu.Lock()
				newer := slot.pending != ""
				c.mu.Unlock()
				if newer {
					return nil // een nieuwere status gaat voor
				}
				return c.do(ctx, http.MethodPost, "/api/remote/servers/"+uuid+"/status", map[string]string{"state": st}, nil)
			})
		}
	}()
}

// Event is het verzoek van POST /api/remote/servers/{uuid}/event.
type Event struct {
	Type           string   `json:"type"` // crashed, disk_warning, disk_exceeded
	ExitCode       *int     `json:"exit_code,omitempty"`
	OOM            bool     `json:"oom,omitempty"`
	LogTail        []string `json:"log_tail,omitempty"`
	CrashReport    *string  `json:"crash_report,omitempty"`
	Restart        string   `json:"restart,omitempty"` // restarted, gave_up, disabled
	RestartAttempt int      `json:"restart_attempt,omitempty"`
	DiskBytes      int64    `json:"disk_bytes,omitempty"`
	DiskLimitBytes int64    `json:"disk_limit_bytes,omitempty"`
}

// ReportEvent meldt een gebeurtenis die een melding kan opleveren (asynchroon met retry).
func (c *Client) ReportEvent(uuid string, ev Event) {
	c.async("event "+uuid, func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, "/api/remote/servers/"+uuid+"/event", ev, nil)
	})
}

func (c *Client) async(what string, fn func(context.Context) error) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		_ = c.retry(context.Background(), what, fn)
	}()
}

// Wait wacht tot alle lopende verzoeken klaar zijn (voor tests).
func (c *Client) Wait() { c.wg.Wait() }

// SFTPAuth is het antwoord van POST /api/remote/sftp/auth.
type SFTPAuth struct {
	ServerUUID  string   `json:"server_uuid"`
	UserID      string   `json:"user_id"`
	Permissions []string `json:"permissions"`
}

// SFTPAuth controleert een SFTP-login bij het panel (synchroon, geen retry).
// Bij een weigering is de fout een *StatusError (403/429).
func (c *Client) SFTPAuth(ctx context.Context, username, password, ip string) (*SFTPAuth, error) {
	var out SFTPAuth
	err := c.do(ctx, http.MethodPost, "/api/remote/sftp/auth", map[string]string{"username": username, "password": password, "ip": ip}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ReportBackup meldt het resultaat van een backup (asynchroon met retry).
func (c *Client) ReportBackup(id int, ok bool, sha256 string, size int64, errMsg string) {
	body := map[string]any{"successful": ok, "sha256": nil, "size_bytes": nil, "error": nil}
	if ok {
		body["sha256"], body["size_bytes"] = sha256, size
	} else {
		body["error"] = errMsg
	}
	c.async(fmt.Sprintf("backup %d", id), func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/remote/backups/%d", id), body, nil)
	})
}

// ReportRestore meldt het resultaat van een herstel (asynchroon met retry).
func (c *Client) ReportRestore(id int, ok bool, errMsg string) {
	body := map[string]any{"successful": ok, "error": nil}
	if !ok {
		body["error"] = errMsg
	}
	c.async(fmt.Sprintf("restore %d", id), func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/remote/backups/%d/restore", id), body, nil)
	})
}

// ImageSettings zijn de globale instellingen uit het panel (GET /api/remote/settings/image-updates).
type ImageSettings struct {
	DefaultPolicy string `json:"default_policy"` // auto | notify | off
	WindowStart   string `json:"window_start"`   // HH:MM
	WindowEnd     string `json:"window_end"`     // HH:MM; mag voor WindowStart liggen
	Timezone      string `json:"timezone"`
}

// ImageStatus is één server in POST /api/remote/node/images.
type ImageStatus struct {
	UUID              string    `json:"uuid"`
	Image             string    `json:"image"`
	CurrentImageID    *string   `json:"current_image_id"`
	LatestImageID     *string   `json:"latest_image_id"`
	UpdateAvailable   bool      `json:"update_available"`
	ReinstallRequired bool      `json:"reinstall_required"`
	CheckedAt         time.Time `json:"checked_at"`
}

// ImageUpdateResult is POST /api/remote/servers/{uuid}/image-update.
type ImageUpdateResult struct {
	Successful bool    `json:"successful"`
	Mode       string  `json:"mode"` // auto | manual
	From       *string `json:"from_image_id"`
	To         *string `json:"to_image_id"`
	Error      *string `json:"error"`
}

// ACMEDNS zet ("present") of verwijdert ("cleanup") het TXT-record _acme-challenge.<node-domein> via het panel.
func (c *Client) ACMEDNS(ctx context.Context, action, value string) error {
	return c.do(ctx, http.MethodPost, "/api/remote/acme/dns", map[string]string{"action": action, "value": value}, nil)
}

// RelayConfig haalt GET /api/remote/relay op en decodeert hem in out. Een leeg antwoord (204) of 404
// (ouder panel) laat out ongewijzigd en geeft found=false.
func (c *Client) RelayConfig(ctx context.Context, out any) (found bool, err error) {
	var raw json.RawMessage
	err = c.do(ctx, http.MethodGet, "/api/remote/relay", nil, &raw)
	if se, ok := err.(*StatusError); ok && se.Code == http.StatusNotFound {
		return false, nil
	}
	if err == io.EOF || (err == nil && len(raw) == 0) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, out)
}

// ReportRelay meldt de toestand van de relay-tunnel (POST /api/remote/relay/status); één poging, best effort.
func (c *Client) ReportRelay(st any) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.do(ctx, http.MethodPost, "/api/remote/relay/status", st, nil); err != nil {
			c.Log.Debug("relay status to panel failed", "err", err)
		}
	}()
}
