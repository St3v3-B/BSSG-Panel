package engine

import (
	"context"
	"fmt"
	"io"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Fake is een Engine in geheugen voor tests. Elke gestarte container draait Behavior
// (of DefaultBehavior) in een goroutine: die leest stdin-regels en schrijft uitvoer.
type Fake struct {
	mu         sync.Mutex
	containers map[string]*FakeContainer
	byName     map[string]string
	images     map[string]bool
	localIDs   map[string]string // ref → lokaal image-id
	remoteIDs  map[string]string // ref → id dat het "register" nu aanbiedt
	imageEnvs  map[string][]string
	imageSet   map[string]bool // aanwezige image-id's
	// PullLog bevat elke ref die PullImage opgehaald heeft.
	PullLog []string
	seq     int

	// Behavior bepaalt wat een container doet; standaard DefaultBehavior.
	Behavior func(c *FakeContainer)
	// Pulls telt EnsureImage-aanroepen die moesten "ophalen".
	Pulls int
	// FailCreate, als gezet, laat Create falen.
	FailCreate error
	// FailPull, als gezet, laat PullImage falen.
	FailPull error

	networks map[string]*FakeNetwork

	// ExecHandler beantwoordt Exec; standaard exitcode 0 en lege uitvoer.
	ExecHandler func(id string, o ExecOptions) (ExecResult, error)
	// ExecIOHandler beantwoordt ExecStream; standaard exitcode 0 en lege uitvoer.
	ExecIOHandler func(id string, o ExecIO) (ExecIOResult, error)
	execs         []ExecOptions
}

// Execs geeft de tot nu toe uitgevoerde Exec-aanroepen.
func (f *Fake) Execs() []ExecOptions {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ExecOptions(nil), f.execs...)
}

func (f *Fake) Exec(ctx context.Context, id string, o ExecOptions) (ExecResult, error) {
	c, err := f.get(id)
	if err != nil {
		return ExecResult{}, err
	}
	c.mu.Lock()
	running := c.running
	c.mu.Unlock()
	if !running {
		return ExecResult{}, fmt.Errorf("container %s is not running", id)
	}
	f.mu.Lock()
	f.execs = append(f.execs, o)
	h := f.ExecHandler
	f.mu.Unlock()
	if h != nil {
		return h(id, o)
	}
	return ExecResult{}, nil
}

// ExecStream in de fake: ExecIOHandler als die gezet is, anders exitcode 0 zonder uitvoer.
func (f *Fake) ExecStream(_ context.Context, id string, o ExecIO) (ExecIOResult, error) {
	if _, err := f.get(id); err != nil {
		return ExecIOResult{}, err
	}
	f.mu.Lock()
	h := f.ExecIOHandler
	f.mu.Unlock()
	if h != nil {
		return h(id, o)
	}
	return ExecIOResult{}, nil
}

// FakeNetwork is een netwerk in de fake.
type FakeNetwork struct {
	Labels    map[string]string
	Internal  bool
	Subnet    netip.Prefix
	Connected map[string]bool // containernamen
}

// AddNetwork maakt een netwerk aan (zoals compose dat zou doen).
func (f *Fake) AddNetwork(name string, labels map[string]string) {
	_ = f.CreateNetwork(context.Background(), name, NetworkOptions{Labels: labels})
}

// Network geeft een kopie van een netwerk, of nil.
func (f *Fake) Network(name string) *FakeNetwork {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.networks[name]
	if !ok {
		return nil
	}
	c := &FakeNetwork{Labels: n.Labels, Internal: n.Internal, Subnet: n.Subnet, Connected: map[string]bool{}}
	for k, v := range n.Connected {
		c.Connected[k] = v
	}
	return c
}

func (f *Fake) NetworkLabels(_ context.Context, name string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.networks[name]
	if !ok {
		return nil, ErrNotFound
	}
	return n.Labels, nil
}

func (f *Fake) CreateNetwork(_ context.Context, name string, o NetworkOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.networks == nil {
		f.networks = map[string]*FakeNetwork{}
	}
	if _, ok := f.networks[name]; ok {
		return fmt.Errorf("network %s already exists", name)
	}
	if o.Subnet.IsValid() {
		for n, x := range f.networks {
			if x.Subnet.IsValid() && x.Subnet.Overlaps(o.Subnet) {
				return fmt.Errorf("Pool overlaps with other one on this address space (%s)", n)
			}
		}
	}
	f.networks[name] = &FakeNetwork{Labels: o.Labels, Internal: o.Internal, Subnet: o.Subnet, Connected: map[string]bool{}}
	return nil
}

func (f *Fake) NetworkSubnets(context.Context) ([]netip.Prefix, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []netip.Prefix
	for _, n := range f.networks {
		if n.Subnet.IsValid() {
			out = append(out, n.Subnet)
		}
	}
	return out, nil
}

func (f *Fake) ListNetworks(_ context.Context, labels map[string]string) ([]NetworkInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []NetworkInfo
outer:
	for name, n := range f.networks {
		for k, v := range labels {
			if n.Labels[k] != v {
				continue outer
			}
		}
		ni := NetworkInfo{Name: name, Labels: n.Labels}
		for c := range n.Connected {
			ni.Containers = append(ni.Containers, c)
		}
		out = append(out, ni)
	}
	return out, nil
}

func (f *Fake) RemoveNetwork(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.networks[name]
	if !ok {
		return ErrNotFound
	}
	if len(n.Connected) > 0 {
		return fmt.Errorf("network %s still has active endpoints", name)
	}
	delete(f.networks, name)
	return nil
}

func (f *Fake) containerName(idOrName string) (string, bool) {
	if _, ok := f.byName[idOrName]; ok {
		return idOrName, true
	}
	if c, ok := f.containers[idOrName]; ok {
		return c.Config.Name, true
	}
	return "", false
}

func (f *Fake) ConnectNetwork(_ context.Context, net, container string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.networks[net]
	name, cok := f.containerName(container)
	if !ok || !cok {
		return ErrNotFound
	}
	n.Connected[name] = true
	return nil
}

func (f *Fake) DisconnectNetwork(_ context.Context, net, container string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.networks[net]
	if !ok {
		return ErrNotFound
	}
	name, _ := f.containerName(container)
	if name == "" {
		name = container
	}
	delete(n.Connected, name)
	return nil
}

var _ Engine = (*Fake)(nil)

// NewFake maakt een lege fake.
func NewFake() *Fake {
	return &Fake{containers: map[string]*FakeContainer{}, byName: map[string]string{}, images: map[string]bool{}, localIDs: map[string]string{}, remoteIDs: map[string]string{}, imageEnvs: map[string][]string{}, imageSet: map[string]bool{}}
}

// FakeContainer is een container in de fake.
type FakeContainer struct {
	ID      string
	ImageID string
	Config  ContainerConfig

	f       *Fake
	mu      sync.Mutex
	cond    *sync.Cond
	out     []byte
	running bool
	started time.Time
	exit    int
	oom     bool
	exited  chan struct{}
	stdin   chan string
	updates []Resources
}

// Stdin geeft de regels die naar stdin geschreven zijn.
func (c *FakeContainer) Stdin() <-chan string { return c.stdin }

// Println schrijft een regel naar de uitvoer.
func (c *FakeContainer) Println(s string) {
	c.mu.Lock()
	c.out = append(c.out, s...)
	c.out = append(c.out, '\n')
	c.mu.Unlock()
	c.cond.Broadcast()
}

// Exit laat de container stoppen met code.
func (c *FakeContainer) Exit(code int) {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		return
	}
	c.running = false
	c.exit = code
	close(c.exited)
	c.mu.Unlock()
	c.cond.Broadcast()
}

// ExitOOM laat de container stoppen alsof de kernel hem doodde (exitcode 137, OOMKilled).
func (c *FakeContainer) ExitOOM() {
	c.mu.Lock()
	c.oom = true
	c.mu.Unlock()
	c.Exit(137)
}

// Exited is gesloten zodra de container gestopt is.
func (c *FakeContainer) Exited() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.exited
}

// Running geeft aan of de container draait.
func (c *FakeContainer) Running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running
}

// Updates zijn de Update-aanroepen.
func (c *FakeContainer) Updates() []Resources {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Resources(nil), c.updates...)
}

// DefaultBehavior: install-containers schrijven twee regels en stoppen met 0; andere
// containers printen een startregel en "Done (1.0s)!", echoën stdin als
// "[Server] <regel>" en stoppen bij "stop".
func DefaultBehavior(c *FakeContainer) {
	if c.Config.Labels["panel.role"] == "install" {
		c.Println("installing")
		c.Println("install done")
		c.Exit(0)
		return
	}
	exited := c.Exited()
	c.Println("Starting fake server")
	c.Println("Done (1.0s)! For help, type \"help\"")
	for {
		select {
		case l := <-c.stdin:
			if l == "stop" {
				c.Println("Stopping server")
				c.Exit(0)
				return
			}
			c.Println("[Server] " + strings.TrimPrefix(l, "say "))
		case <-exited:
			return
		}
	}
}

func (f *Fake) get(id string) (*FakeContainer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.containers[id]; ok {
		return c, nil
	}
	if real, ok := f.byName[id]; ok {
		return f.containers[real], nil
	}
	return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
}

// Container zoekt een container op id of naam (nil als hij niet bestaat).
func (f *Fake) Container(idOrName string) *FakeContainer {
	c, _ := f.get(idOrName)
	return c
}

// All geeft alle containers.
func (f *Fake) All() []*FakeContainer {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*FakeContainer, 0, len(f.containers))
	for _, c := range f.containers {
		out = append(out, c)
	}
	return out
}

func (f *Fake) Version(context.Context) (string, error) { return "fake-1.0", nil }

func (f *Fake) EnsureImage(_ context.Context, image string, progress func(string)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.images[image] {
		f.images[image] = true
		f.localIDs[image] = f.remoteIDLocked(image)
		f.imageSet[f.localIDs[image]] = true
		f.Pulls++
		if progress != nil {
			progress("pulled " + image)
		}
	}
	return nil
}

func (f *Fake) Create(_ context.Context, cfg ContainerConfig) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.FailCreate != nil {
		return "", f.FailCreate
	}
	if _, ok := f.byName[cfg.Name]; ok {
		return "", fmt.Errorf("name %s already exists", cfg.Name)
	}
	f.seq++
	imgID := f.localIDs[cfg.Image]
	c := &FakeContainer{ID: fmt.Sprintf("fake%04d", f.seq), ImageID: imgID, Config: cfg, f: f, exited: make(chan struct{}), stdin: make(chan string, 100)}
	c.cond = sync.NewCond(&c.mu)
	f.containers[c.ID] = c
	f.byName[cfg.Name] = c.ID
	if n, ok := f.networks[cfg.NetworkMode]; ok {
		n.Connected[cfg.Name] = true
	}
	return c.ID, nil
}

func (f *Fake) Start(_ context.Context, id string) error {
	c, err := f.get(id)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return nil
	}
	c.running = true
	c.started = time.Now()
	c.oom = false
	c.exited = make(chan struct{})
	c.mu.Unlock()
	b := f.Behavior
	if b == nil {
		b = DefaultBehavior
	}
	go b(c)
	return nil
}

func (f *Fake) Kill(_ context.Context, id, _ string) error {
	c, err := f.get(id)
	if err != nil {
		return err
	}
	c.Exit(137)
	return nil
}

func (f *Fake) Remove(_ context.Context, id string) error {
	c, err := f.get(id)
	if err != nil {
		return err
	}
	c.Exit(137)
	f.mu.Lock()
	delete(f.containers, c.ID)
	delete(f.byName, c.Config.Name)
	for _, n := range f.networks {
		delete(n.Connected, c.Config.Name)
	}
	f.mu.Unlock()
	return nil
}

func (f *Fake) Inspect(_ context.Context, id string) (Container, error) {
	c, err := f.get(id)
	if err != nil {
		return Container{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return Container{ID: c.ID, Name: c.Config.Name, Labels: c.Config.Labels, Running: c.running, StartedAt: c.started, ExitCode: c.exit, OOMKilled: c.oom, ImageID: c.ImageID}, nil
}

func (f *Fake) List(_ context.Context, labels map[string]string) ([]Container, error) {
	var out []Container
	for _, c := range f.All() {
		ok := true
		for k, v := range labels {
			if c.Config.Labels[k] != v {
				ok = false
			}
		}
		if ok {
			c.mu.Lock()
			out = append(out, Container{ID: c.ID, Name: c.Config.Name, Labels: c.Config.Labels, Running: c.running, StartedAt: c.started, ImageID: c.ImageID})
			c.mu.Unlock()
		}
	}
	return out, nil
}

type fakeStdin struct {
	c      *FakeContainer
	mu     sync.Mutex
	buf    []byte
	closed bool
}

func (s *fakeStdin) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, io.ErrClosedPipe
	}
	s.buf = append(s.buf, p...)
	for {
		i := strings.IndexByte(string(s.buf), '\n')
		if i < 0 {
			break
		}
		line := string(s.buf[:i])
		s.buf = s.buf[i+1:]
		select {
		case s.c.stdin <- line:
		default:
		}
	}
	return len(p), nil
}

func (s *fakeStdin) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	return nil
}

func (f *Fake) AttachStdin(_ context.Context, id string) (Attachment, error) {
	c, err := f.get(id)
	if err != nil {
		return nil, err
	}
	return &fakeStdin{c: c}, nil
}

type fakeLogs struct {
	c      *FakeContainer
	off    int
	follow bool
	ctx    context.Context
	closed bool
}

func (l *fakeLogs) Read(p []byte) (int, error) {
	c := l.c
	c.mu.Lock()
	defer c.mu.Unlock()
	for {
		if l.closed || l.ctx.Err() != nil {
			return 0, io.EOF
		}
		if l.off < len(c.out) {
			n := copy(p, c.out[l.off:])
			l.off += n
			return n, nil
		}
		if !l.follow || !c.running {
			return 0, io.EOF
		}
		c.cond.Wait()
	}
}

func (l *fakeLogs) Close() error {
	l.c.mu.Lock()
	l.closed = true
	l.c.mu.Unlock()
	l.c.cond.Broadcast()
	return nil
}

func (f *Fake) Logs(ctx context.Context, id string, follow bool) (io.ReadCloser, error) {
	c, err := f.get(id)
	if err != nil {
		return nil, err
	}
	l := &fakeLogs{c: c, follow: follow, ctx: ctx}
	go func() {
		<-ctx.Done()
		c.cond.Broadcast()
	}()
	return l, nil
}

func (f *Fake) Wait(ctx context.Context, id string) (int, error) {
	c, err := f.get(id)
	if err != nil {
		return -1, err
	}
	c.mu.Lock()
	ch := c.exited
	running := c.running
	c.mu.Unlock()
	if running {
		select {
		case <-ch:
		case <-ctx.Done():
			return -1, ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.exit, nil
}

func (f *Fake) Stats(ctx context.Context, id string, fn func(StatsSample)) error {
	c, err := f.get(id)
	if err != nil {
		return err
	}
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-c.Exited():
			return nil
		case <-t.C:
			fn(StatsSample{CPUPct: 12.5, MemoryBytes: 64 << 20, MemoryLimit: c.Config.Resources.Memory, RxBytes: 100, TxBytes: 200})
		}
	}
}

func (f *Fake) Update(_ context.Context, id string, r Resources) error {
	c, err := f.get(id)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.updates = append(c.updates, r)
	c.mu.Unlock()
	return nil
}
