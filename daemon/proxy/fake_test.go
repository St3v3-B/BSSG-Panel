package proxy

import (
	"context"
	"errors"
	"testing"
)

func TestFakeSetRemoveSync(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	if err := f.SetRoute(ctx, Route{Host: "Site.Test", ServerUUID: "u1", Upstream: Upstream{Container: "c", Port: 80}}); err != nil {
		t.Fatal(err)
	}
	st, err := f.Status(ctx, "site.test")
	if err != nil || st.SSL != SSLActive {
		t.Fatalf("status = %+v, %v", st, err)
	}
	if err := f.Sync(ctx, []Route{{Host: "b.test"}, {Host: "a.test"}}); err != nil {
		t.Fatal(err)
	}
	if got := f.Routes(); len(got) != 2 || got[0].Host != "a.test" {
		t.Fatalf("routes = %+v", got)
	}
	if err := f.RemoveRoute(ctx, "site.test"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("verwacht ErrNotFound, kreeg %v", err)
	}
}
