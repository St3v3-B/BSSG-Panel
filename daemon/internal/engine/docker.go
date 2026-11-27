package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
)

// Docker is de echte Engine via de Docker SDK.
type Docker struct {
	cli *client.Client
}

var _ Engine = (*Docker)(nil)

// NewDocker verbindt met Docker volgens DOCKER_HOST (standaard de unix-socket).
func NewDocker() (*Docker, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}
	return &Docker{cli: cli}, nil
}

func wrap(err error) error {
	if err == nil {
		return nil
	}
	if errdefs.IsNotFound(err) {
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	}
	return err
}

func (d *Docker) Version(ctx context.Context) (string, error) {
	v, err := d.cli.ServerVersion(ctx)
	if err != nil {
		return "", err
	}
	return v.Version, nil
}

func (d *Docker) EnsureImage(ctx context.Context, ref string, progress func(string)) error {
	if _, err := d.cli.ImageInspect(ctx, ref); err == nil {
		return nil
	} else if !errdefs.IsNotFound(err) {
		return err
	}
	if progress != nil {
		progress("image ophalen: " + ref)
	}
	rc, err := d.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return err
	}
	defer rc.Close()
	dec := json.NewDecoder(rc)
	last := ""
	for {
		var m struct {
			Status string `json:"status"`
			ID     string `json:"id"`
			Error  string `json:"error"`
		}
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if m.Error != "" {
			return errors.New(m.Error)
		}
		// Alleen statuswijzigingen zonder laag-id (anders honderden regels).
		if progress != nil && m.ID == "" && m.Status != last {
			last = m.Status
			progress(m.Status)
		}
	}
}

func (d *Docker) Create(ctx context.Context, c ContainerConfig) (string, error) {
	exposed := nat.PortSet{}
	bindings := nat.PortMap{}
	for _, p := range c.Ports {
		port, err := nat.NewPort(p.Proto, strconv.Itoa(p.ContainerPort))
		if err != nil {
			return "", err
		}
		exposed[port] = struct{}{}
		bindings[port] = append(bindings[port], nat.PortBinding{HostIP: p.HostIP, HostPort: strconv.Itoa(p.HostPort)})
	}
	var mounts []mount.Mount
	for _, m := range c.Mounts {
		mounts = append(mounts, mount.Mount{Type: mount.TypeBind, Source: m.Source, Target: m.Target})
	}
	pids := c.Resources.PidsLimit
	cfg := &container.Config{
		Image:        c.Image,
		Entrypoint:   c.Entrypoint,
		Cmd:          c.Cmd,
		Env:          c.Env,
		Labels:       c.Labels,
		User:         c.User,
		WorkingDir:   c.WorkingDir,
		OpenStdin:    c.OpenStdin,
		AttachStdin:  c.OpenStdin,
		AttachStdout: true,
		AttachStderr: true,
		StdinOnce:    false,
		Tty:          false,
		ExposedPorts: exposed,
	}
	host := &container.HostConfig{
		Mounts:         mounts,
		ReadonlyRootfs: c.ReadOnlyRootfs,
		Tmpfs:          c.Tmpfs,
		CapDrop:        c.CapDrop,
		SecurityOpt:    c.SecurityOpt,
		PortBindings:   bindings,
		NetworkMode:    container.NetworkMode(c.NetworkMode),
		Init:           &c.Init,
		LogConfig:      container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "20m", "max-file": "2"}},
		Resources: container.Resources{
			NanoCPUs:   c.Resources.NanoCPUs,
			Memory:     c.Resources.Memory,
			MemorySwap: c.Resources.MemorySwap,
			PidsLimit:  &pids,
		},
	}
	resp, err := d.cli.ContainerCreate(ctx, cfg, host, nil, nil, c.Name)
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}

func (d *Docker) Start(ctx context.Context, id string) error {
	return wrap(d.cli.ContainerStart(ctx, id, container.StartOptions{}))
}

func (d *Docker) Kill(ctx context.Context, id, signal string) error {
	return wrap(d.cli.ContainerKill(ctx, id, signal))
}

func (d *Docker) Remove(ctx context.Context, id string) error {
	return wrap(d.cli.ContainerRemove(ctx, id, container.RemoveOptions{Force: true}))
}

func (d *Docker) Inspect(ctx context.Context, id string) (Container, error) {
	r, err := d.cli.ContainerInspect(ctx, id)
	if err != nil {
		return Container{}, wrap(err)
	}
	c := Container{ID: r.ID, Name: strings.TrimPrefix(r.Name, "/"), ImageID: r.Image}
	if r.Config != nil {
		c.Labels = r.Config.Labels
	}
	if r.State != nil {
		c.Running = r.State.Running
		c.ExitCode = r.State.ExitCode
		c.OOMKilled = r.State.OOMKilled
		c.StartedAt, _ = time.Parse(time.RFC3339Nano, r.State.StartedAt)
	}
	return c, nil
}

func (d *Docker) List(ctx context.Context, labels map[string]string) ([]Container, error) {
	f := filters.NewArgs()
	for k, v := range labels {
		f.Add("label", k+"="+v)
	}
	list, err := d.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(list))
	for _, s := range list {
		c := Container{ID: s.ID, Labels: s.Labels, Running: s.State == "running", ImageID: s.ImageID}
		if len(s.Names) > 0 {
			c.Name = strings.TrimPrefix(s.Names[0], "/")
		}
		out = append(out, c)
	}
	return out, nil
}

type hijacked struct {
	conn io.WriteCloser
}

func (h *hijacked) Write(p []byte) (int, error) { return h.conn.Write(p) }
func (h *hijacked) Close() error                { return h.conn.Close() }

func (d *Docker) AttachStdin(ctx context.Context, id string) (Attachment, error) {
	resp, err := d.cli.ContainerAttach(ctx, id, container.AttachOptions{Stream: true, Stdin: true})
	if err != nil {
		return nil, wrap(err)
	}
	return &hijacked{conn: resp.Conn}, nil
}

func (d *Docker) Logs(ctx context.Context, id string, follow bool) (io.ReadCloser, error) {
	rc, err := d.cli.ContainerLogs(ctx, id, container.LogsOptions{ShowStdout: true, ShowStderr: true, Follow: follow, Tail: "all"})
	if err != nil {
		return nil, wrap(err)
	}
	pr, pw := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(pw, pw, rc)
		rc.Close()
		pw.CloseWithError(err)
	}()
	return &pipeCloser{PipeReader: pr, src: rc}, nil
}

type pipeCloser struct {
	*io.PipeReader
	src io.Closer
}

func (p *pipeCloser) Close() error {
	p.src.Close()
	return p.PipeReader.Close()
}

func (d *Docker) Wait(ctx context.Context, id string) (int, error) {
	ch, errCh := d.cli.ContainerWait(ctx, id, container.WaitConditionNotRunning)
	select {
	case r := <-ch:
		if r.Error != nil && r.Error.Message != "" {
			return int(r.StatusCode), errors.New(r.Error.Message)
		}
		return int(r.StatusCode), nil
	case err := <-errCh:
		return -1, wrap(err)
	}
}

func (d *Docker) Stats(ctx context.Context, id string, fn func(StatsSample)) error {
	resp, err := d.cli.ContainerStats(ctx, id, true)
	if err != nil {
		return wrap(err)
	}
	defer resp.Body.Close()
	dec := json.NewDecoder(resp.Body)
	for {
		var s container.StatsResponse
		if err := dec.Decode(&s); err != nil {
			if errors.Is(err, io.EOF) || ctx.Err() != nil {
				return nil
			}
			return err
		}
		fn(convertStats(&s))
	}
}

func convertStats(s *container.StatsResponse) StatsSample {
	out := StatsSample{MemoryLimit: int64(s.MemoryStats.Limit)}
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemUsage) - float64(s.PreCPUStats.SystemUsage)
	online := float64(s.CPUStats.OnlineCPUs)
	if online == 0 {
		online = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpuDelta > 0 && sysDelta > 0 {
		out.CPUPct = cpuDelta / sysDelta * online * 100
	}
	mem := int64(s.MemoryStats.Usage)
	for _, k := range []string{"inactive_file", "total_inactive_file"} {
		if v, ok := s.MemoryStats.Stats[k]; ok && int64(v) < mem {
			mem -= int64(v)
			break
		}
	}
	out.MemoryBytes = mem
	for _, n := range s.Networks {
		out.RxBytes += int64(n.RxBytes)
		out.TxBytes += int64(n.TxBytes)
	}
	return out
}

func (d *Docker) Update(ctx context.Context, id string, r Resources) error {
	pids := r.PidsLimit
	_, err := d.cli.ContainerUpdate(ctx, id, container.UpdateConfig{Resources: container.Resources{
		NanoCPUs:   r.NanoCPUs,
		Memory:     r.Memory,
		MemorySwap: r.MemorySwap,
		PidsLimit:  &pids,
	}})
	return wrap(err)
}

// tailBuffer bewaart de laatste max bytes van wat erin geschreven wordt.
type tailBuffer struct {
	max       int
	buf       []byte
	truncated bool
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	b.buf = append(b.buf, p...)
	if b.max > 0 && len(b.buf) > b.max {
		b.buf = append([]byte(nil), b.buf[len(b.buf)-b.max:]...)
		b.truncated = true
	}
	return n, nil
}

func (d *Docker) Exec(ctx context.Context, id string, o ExecOptions) (ExecResult, error) {
	ex, err := d.cli.ContainerExecCreate(ctx, id, container.ExecOptions{Cmd: o.Cmd, User: o.User, WorkingDir: o.WorkingDir, AttachStdout: true, AttachStderr: true})
	if err != nil {
		return ExecResult{}, wrap(err)
	}
	att, err := d.cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		return ExecResult{}, wrap(err)
	}
	defer att.Close()
	tb := &tailBuffer{max: o.MaxOutput}
	copyDone := make(chan error, 1)
	go func() {
		_, err := stdcopy.StdCopy(tb, tb, att.Reader)
		copyDone <- err
	}()
	select {
	case <-copyDone:
	case <-ctx.Done():
		att.Close()
		return ExecResult{}, ctx.Err()
	}
	for i := 0; i < 100; i++ {
		r, err := d.cli.ContainerExecInspect(ctx, ex.ID)
		if err != nil {
			return ExecResult{}, wrap(err)
		}
		if !r.Running {
			return ExecResult{ExitCode: r.ExitCode, Output: string(tb.buf), Truncated: tb.truncated}, nil
		}
		select {
		case <-ctx.Done():
			return ExecResult{}, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return ExecResult{}, errors.New("exec did not finish")
}

// ExecStream: zie Engine. Stdin wordt gekopieerd en daarna gesloten (EOF); stdout gaat naar o.Stdout.
func (d *Docker) ExecStream(ctx context.Context, id string, o ExecIO) (ExecIOResult, error) {
	ex, err := d.cli.ContainerExecCreate(ctx, id, container.ExecOptions{Cmd: o.Cmd, Env: o.Env, AttachStdin: true, AttachStdout: true, AttachStderr: true})
	if err != nil {
		return ExecIOResult{}, wrap(err)
	}
	att, err := d.cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		return ExecIOResult{}, wrap(err)
	}
	defer att.Close()
	go func() {
		if o.Stdin != nil {
			_, _ = io.Copy(att.Conn, o.Stdin)
		}
		_ = att.CloseWrite()
	}()
	max := o.MaxStderr
	if max <= 0 {
		max = 4096
	}
	errTail := &tailBuffer{max: max}
	var out io.Writer = io.Discard
	if o.Stdout != nil {
		out = o.Stdout
	}
	copyDone := make(chan error, 1)
	go func() {
		_, err := stdcopy.StdCopy(out, errTail, att.Reader)
		copyDone <- err
	}()
	select {
	case err := <-copyDone:
		if err != nil {
			return ExecIOResult{}, err
		}
	case <-ctx.Done():
		att.Close()
		return ExecIOResult{}, ctx.Err()
	}
	for i := 0; i < 200; i++ {
		r, err := d.cli.ContainerExecInspect(ctx, ex.ID)
		if err != nil {
			return ExecIOResult{}, wrap(err)
		}
		if !r.Running {
			return ExecIOResult{ExitCode: r.ExitCode, Stderr: string(errTail.buf)}, nil
		}
		select {
		case <-ctx.Done():
			return ExecIOResult{}, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return ExecIOResult{}, errors.New("exec did not finish")
}
