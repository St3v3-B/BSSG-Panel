package mcproto

import (
	"errors"
	"net"
	"sync"
	"time"
)

// Listener luistert namens een slapende server op zijn poort.
type Listener struct {
	ln    net.Listener
	rs    *Responder
	wg    sync.WaitGroup
	mu    sync.Mutex
	perIP map[string]int
	total int

	// MaxConns totaal en MaxPerIP tegelijk open verbindingen.
	MaxConns, MaxPerIP int
}

// Listen bindt addr (tcp) en beantwoordt verbindingen met rs.
func Listen(addr string, rs *Responder) (*Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	l := &Listener{ln: ln, rs: rs, perIP: map[string]int{}, MaxConns: 64, MaxPerIP: 4}
	l.wg.Add(1)
	go l.accept()
	return l, nil
}

// Addr is het luisteradres.
func (l *Listener) Addr() string { return l.ln.Addr().String() }

// Close sluit de listener en wacht tot alle verbindingen klaar zijn (hooguit de timeout).
func (l *Listener) Close() {
	_ = l.ln.Close()
	l.wg.Wait()
}

func (l *Listener) accept() {
	defer l.wg.Done()
	for {
		c, err := l.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			time.Sleep(50 * time.Millisecond)
			continue
		}
		ip, _, _ := net.SplitHostPort(c.RemoteAddr().String())
		l.mu.Lock()
		if l.total >= l.MaxConns || l.perIP[ip] >= l.MaxPerIP {
			l.mu.Unlock()
			c.Close()
			continue
		}
		l.total++
		l.perIP[ip]++
		l.mu.Unlock()
		l.wg.Add(1)
		go func() {
			defer l.wg.Done()
			_ = l.rs.Serve(c)
			l.mu.Lock()
			l.total--
			if l.perIP[ip]--; l.perIP[ip] <= 0 {
				delete(l.perIP, ip)
			}
			l.mu.Unlock()
		}()
	}
}
