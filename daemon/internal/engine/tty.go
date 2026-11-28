package engine

import (
	"bufio"
	"context"
	"io"
	"net"

	"github.com/docker/docker/api/types/container"
)

// TTY is het deel van een Engine voor interactieve shells (containers met ContainerConfig.Tty).
// Docker en Fake implementeren het; de daemon vraagt het op met een type-assertie.
type TTY interface {
	// AttachTTY koppelt stdin+stdout van een tty-container (vóór de start, zodat niets verloren gaat).
	AttachTTY(ctx context.Context, id string) (io.ReadWriteCloser, error)
	// ResizeTTY zet de venstergrootte.
	ResizeTTY(ctx context.Context, id string, rows, cols uint) error
}

var _ TTY = (*Docker)(nil)

type ttyConn struct {
	r    *bufio.Reader
	conn net.Conn
}

func (t *ttyConn) Read(p []byte) (int, error)  { return t.r.Read(p) }
func (t *ttyConn) Write(p []byte) (int, error) { return t.conn.Write(p) }
func (t *ttyConn) Close() error                { return t.conn.Close() }

func (d *Docker) AttachTTY(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	resp, err := d.cli.ContainerAttach(ctx, id, container.AttachOptions{Stream: true, Stdin: true, Stdout: true, Stderr: true})
	if err != nil {
		return nil, wrap(err)
	}
	// Met een tty is de stroom ruw (geen stdcopy-multiplexing).
	return &ttyConn{r: resp.Reader, conn: resp.Conn}, nil
}

func (d *Docker) ResizeTTY(ctx context.Context, id string, rows, cols uint) error {
	return wrap(d.cli.ContainerResize(ctx, id, container.ResizeOptions{Height: rows, Width: cols}))
}
