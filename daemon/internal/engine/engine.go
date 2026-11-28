// Package engine is de dunne laag tussen de daemon en Docker. De rest van de daemon
// programmeert tegen Engine, zodat tests een fake kunnen gebruiken.
package engine

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotFound: de container bestaat niet.
var ErrNotFound = errors.New("engine: container not found")

// Mount is een bind mount.
type Mount struct {
	Source   string
	Target   string
	ReadOnly bool
}

// PortBinding koppelt hostIP:hostPort aan containerPort/proto.
type PortBinding struct {
	HostIP        string
	HostPort      int
	ContainerPort int
	Proto         string // tcp of udp
}

// Resources zijn de cgroup-limieten.
type Resources struct {
	NanoCPUs   int64 // 0 = onbeperkt
	Memory     int64 // bytes
	MemorySwap int64 // memory+swap in bytes, -1 = onbeperkt
	PidsLimit  int64
}

// ContainerConfig is alles wat de daemon bij het aanmaken van een container instelt.
type ContainerConfig struct {
	Name           string
	Image          string
	Entrypoint     []string
	Cmd            []string
	Env            []string
	Labels         map[string]string
	User           string
	WorkingDir     string
	OpenStdin      bool
	Mounts         []Mount
	ReadOnlyRootfs bool
	Tmpfs          map[string]string
	CapDrop        []string
	SecurityOpt    []string
	Resources      Resources
	Ports          []PortBinding
	NetworkMode    string
	// Init: tini als PID 1, zodat signalen ook processen zonder eigen handler bereiken.
	Init bool
}

// Container is de staat van een bestaande container.
type Container struct {
	ID        string
	Name      string
	Labels    map[string]string
	Running   bool
	StartedAt time.Time
	ExitCode  int
	// ImageID is het id van de image waarmee de container gemaakt is.
	ImageID string
	// OOMKilled: de kernel doodde de container wegens geheugengebrek.
	OOMKilled bool
	// Networks: netwerknaam -> IPv4-adres van de container (alleen gevuld door Inspect).
	Networks map[string]string
}

// Attachment is een stdin-verbinding met een container.
type Attachment interface {
	io.Writer
	Close() error
}

// ExecOptions beschrijft een commando dat in een draaiende container loopt.
type ExecOptions struct {
	Cmd        []string
	User       string // "uid:gid"; nooit leeg (anders root)
	WorkingDir string
	// MaxOutput: bewaar hoogstens de laatste MaxOutput bytes uitvoer.
	MaxOutput int
}

// ExecResult is de uitkomst van Exec.
type ExecResult struct {
	ExitCode  int
	Output    string // stdout+stderr, de laatste MaxOutput bytes
	Truncated bool
}

// ExecIO is een commando met stdin/stdout-stromen (bv. een SQL-dump). stderr wordt apart bewaard.
type ExecIO struct {
	Cmd []string
	Env []string // "K=V"
	// Stdin wordt naar het commando gestuurd (nil: leeg); Stdout krijgt de uitvoer (nil: weggegooid).
	Stdin  io.Reader
	Stdout io.Writer
	// MaxStderr: hoeveel van het einde van stderr bewaard blijft (standaard 4 KiB).
	MaxStderr int
}

// ExecIOResult is de uitkomst van ExecStream.
type ExecIOResult struct {
	ExitCode int
	Stderr   string
}

// StatsSample is één meting uit de Docker-statsstream.
type StatsSample struct {
	CPUPct      float64 // 100 = één core
	MemoryBytes int64
	MemoryLimit int64
	RxBytes     int64
	TxBytes     int64
}

// Engine is het deel van Docker dat de daemon gebruikt.
type Engine interface {
	Version(ctx context.Context) (string, error)
	// EnsureImage haalt de image op als hij lokaal ontbreekt; progress krijgt statusregels.
	EnsureImage(ctx context.Context, image string, progress func(string)) error
	Create(ctx context.Context, cfg ContainerConfig) (string, error)
	Start(ctx context.Context, id string) error
	Kill(ctx context.Context, id, signal string) error
	// Remove verwijdert geforceerd; ErrNotFound als hij niet bestaat.
	Remove(ctx context.Context, id string) error
	Inspect(ctx context.Context, id string) (Container, error)
	// List geeft alle containers (ook gestopte) met al deze labels.
	List(ctx context.Context, labels map[string]string) ([]Container, error)
	// AttachStdin opent stdin van de container (ook vóór de start).
	AttachStdin(ctx context.Context, id string) (Attachment, error)
	// Logs geeft stdout+stderr vanaf de containerstart; follow blijft lezen tot de container stopt.
	Logs(ctx context.Context, id string, follow bool) (io.ReadCloser, error)
	// Wait wacht tot de container niet meer draait en geeft de exitcode.
	Wait(ctx context.Context, id string) (int, error)
	// Stats roept fn aan voor elke meting tot ctx klaar is of de container stopt.
	Stats(ctx context.Context, id string, fn func(StatsSample)) error
	Update(ctx context.Context, id string, r Resources) error
	// Exec draait een commando in een draaiende container en wacht tot het klaar is of ctx afloopt.
	Exec(ctx context.Context, id string, o ExecOptions) (ExecResult, error)
	// ExecStream is Exec met stdin/stdout-stromen; het commando draait als de standaardgebruiker van de container.
	ExecStream(ctx context.Context, id string, o ExecIO) (ExecIOResult, error)
	Networks
	Images
}
