package engine

import (
	"context"
	"io"
	"strings"
	"sync"
)

var _ TTY = (*Fake)(nil)

// fakeSizes: container-id → laatste [rows, cols] van ResizeTTY.
var fakeSizes sync.Map

// TTYSize geeft de laatste ResizeTTY van een fake-container.
func (f *Fake) TTYSize(id string) (rows, cols uint, ok bool) {
	v, ok := fakeSizes.Load(id)
	if !ok {
		return 0, 0, false
	}
	s := v.([2]uint)
	return s[0], s[1], true
}

type fakeTTY struct {
	c      *FakeContainer
	off    int
	closed bool
	mu     sync.Mutex
	line   strings.Builder
}

// Read volgt de uitvoer; wacht tot de container gestart is (attach gebeurt ervoor) en geeft EOF als hij stopt.
func (t *fakeTTY) Read(p []byte) (int, error) {
	c := t.c
	c.mu.Lock()
	defer c.mu.Unlock()
	for {
		if t.closed {
			return 0, io.EOF
		}
		if t.off < len(c.out) {
			n := copy(p, c.out[t.off:])
			t.off += n
			return n, nil
		}
		if !c.started.IsZero() && !c.running {
			return 0, io.EOF
		}
		c.cond.Wait()
	}
}

// Write stuurt elke volledige regel (afgesloten met \r of \n) naar stdin van de container.
func (t *fakeTTY) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, b := range p {
		if b == '\r' || b == '\n' {
			l := t.line.String()
			t.line.Reset()
			select {
			case t.c.stdin <- l:
			default:
			}
			continue
		}
		t.line.WriteByte(b)
	}
	return len(p), nil
}

func (t *fakeTTY) Close() error {
	t.c.mu.Lock()
	t.closed = true
	t.c.mu.Unlock()
	t.c.cond.Broadcast()
	return nil
}

func (f *Fake) AttachTTY(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	c, err := f.get(id)
	if err != nil {
		return nil, err
	}
	return &fakeTTY{c: c}, nil
}

func (f *Fake) ResizeTTY(_ context.Context, id string, rows, cols uint) error {
	c, err := f.get(id)
	if err != nil {
		return err
	}
	fakeSizes.Store(c.ID, [2]uint{rows, cols})
	return nil
}

// ShellBehavior: een fake shell. Print "$ ", echoot elke regel als "out:<regel>", stopt bij "exit"
// (code 0) of "exit <n>"-achtig "fail" (code 3).
func ShellBehavior(c *FakeContainer) {
	exited := c.Exited()
	c.print("$ ")
	for {
		select {
		case l := <-c.stdin:
			switch l {
			case "exit":
				c.Exit(0)
				return
			case "fail":
				c.Exit(3)
				return
			}
			c.Println("out:" + l)
			c.print("$ ")
		case <-exited:
			return
		}
	}
}

func (c *FakeContainer) print(s string) {
	c.mu.Lock()
	c.out = append(c.out, s...)
	c.mu.Unlock()
	c.cond.Broadcast()
}
