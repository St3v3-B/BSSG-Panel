package tlscert

import "context"

// PanelDNS laat het panel de TXT-records zetten.
type PanelDNS struct {
	Do func(ctx context.Context, action, value string) error
}

func (p PanelDNS) Present(ctx context.Context, v string) error { return p.Do(ctx, "present", v) }
func (p PanelDNS) Cleanup(ctx context.Context, v string) error { return p.Do(ctx, "cleanup", v) }
