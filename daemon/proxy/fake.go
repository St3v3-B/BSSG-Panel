package proxy

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// Fake is een Router in geheugen, voor tests van de daemon. Elke route krijgt
// direct SSLActive, tenzij er in Statuses iets anders staat.
type Fake struct {
	mu       sync.Mutex
	routes   map[string]Route
	Statuses map[string]SSLStatus
	// Calls telt aanroepen per methode ("SetRoute", "RemoveRoute", "Sync", "Status").
	Calls map[string]int
	// Err, als gezet, wordt door elke methode teruggegeven (om foutpaden te testen).
	Err error
}

var _ Router = (*Fake)(nil)

func NewFake() *Fake {
	return &Fake{routes: map[string]Route{}, Statuses: map[string]SSLStatus{}, Calls: map[string]int{}}
}

func (f *Fake) SetRoute(_ context.Context, r Route) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls["SetRoute"]++
	if f.Err != nil {
		return f.Err
	}
	r.Host = strings.ToLower(r.Host)
	f.routes[r.Host] = r
	return nil
}

func (f *Fake) RemoveRoute(_ context.Context, host string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls["RemoveRoute"]++
	if f.Err != nil {
		return f.Err
	}
	host = strings.ToLower(host)
	if _, ok := f.routes[host]; !ok {
		return ErrNotFound
	}
	delete(f.routes, host)
	return nil
}

func (f *Fake) Sync(_ context.Context, routes []Route) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls["Sync"]++
	if f.Err != nil {
		return f.Err
	}
	f.routes = make(map[string]Route, len(routes))
	for _, r := range routes {
		r.Host = strings.ToLower(r.Host)
		f.routes[r.Host] = r
	}
	return nil
}

func (f *Fake) Status(_ context.Context, host string) (RouteStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls["Status"]++
	if f.Err != nil {
		return RouteStatus{}, f.Err
	}
	host = strings.ToLower(host)
	if _, ok := f.routes[host]; !ok {
		return RouteStatus{}, ErrNotFound
	}
	st, ok := f.Statuses[host]
	if !ok {
		st = SSLActive
	}
	return RouteStatus{Host: host, SSL: st, CheckedAt: time.Now()}, nil
}

// Routes geeft de huidige routes, gesorteerd op Host.
func (f *Fake) Routes() []Route {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Route, 0, len(f.routes))
	for _, r := range f.routes {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Host < out[j].Host })
	return out
}
