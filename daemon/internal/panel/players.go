package panel

import (
	"context"
	"net/http"
	"time"
)

// PlayerEvent is één gebeurtenis in POST /api/remote/servers/{uuid}/players.
type PlayerEvent struct {
	// Type: join, leave of stopped (de server is gestopt: alle open sessies sluiten).
	Type string    `json:"type"`
	At   time.Time `json:"at"`
	Name string    `json:"name,omitempty"`
	// PlayerUUID uit de UUID-regel van de server (als het patroon er een heeft).
	PlayerUUID string `json:"player_uuid,omitempty"`
	// Reason bij leave en stopped: leave, server_stop, sleep of crash.
	Reason string `json:"reason,omitempty"`
}

// Grenzen van de spelerswachtrij per server.
const (
	MaxPlayerQueue = 1000
	MaxPlayerBatch = 100
)

type playerQueue struct {
	events  []PlayerEvent
	running bool
}

// ReportPlayerEvent zet een gebeurtenis in de wachtrij van de server. Per server loopt hooguit één
// verzoek tegelijk (volgorde blijft behouden); wat intussen binnenkomt gaat in de volgende batch.
// Bij een volle wachtrij vallen de oudste gebeurtenissen weg (het panel herstelt via de ping).
func (c *Client) ReportPlayerEvent(uuid string, ev PlayerEvent) {
	c.mu.Lock()
	if c.players == nil {
		c.players = map[string]*playerQueue{}
	}
	q := c.players[uuid]
	if q == nil {
		q = &playerQueue{}
		c.players[uuid] = q
	}
	if len(q.events) >= MaxPlayerQueue {
		q.events = q.events[1:]
	}
	q.events = append(q.events, ev)
	if q.running {
		c.mu.Unlock()
		return
	}
	q.running = true
	c.mu.Unlock()
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		for {
			c.mu.Lock()
			if len(q.events) == 0 {
				q.running = false
				c.mu.Unlock()
				return
			}
			n := min(len(q.events), MaxPlayerBatch)
			batch := append([]PlayerEvent(nil), q.events[:n]...)
			q.events = q.events[n:]
			c.mu.Unlock()
			_ = c.retry(context.Background(), "players "+uuid, func(ctx context.Context) error {
				return c.do(ctx, http.MethodPost, "/api/remote/servers/"+uuid+"/players", map[string]any{"events": batch}, nil)
			})
		}
	}()
}
