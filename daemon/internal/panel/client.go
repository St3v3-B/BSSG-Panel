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
func (c *Client) Hello(version, diskQuotaMode string) {
	c.async("hello", func(ctx context.Context) error {
		return c.do(ctx, http.MethodPost, "/api/remote/node/hello", map[string]string{"version": version, "disk_quota_mode": diskQuotaMode}, nil)
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
