package mail

import (
	"context"
	"io"
	"path"
	"sort"
	"strings"
	"sync"

	"panel/daemon/internal/engine"
)

// FakeCall is één exec in FakeDocker.
type FakeCall struct {
	Container string
	Argv      []string
	User      string
	Stdin     string
}

// FakeDocker is een Docker voor tests: containers in geheugen, een klein nepbestandssysteem per container voor
// ls/cat/tee/chmod/chown/mv/rm, en Handler voor de rest (doveadm, postqueue, ...).
type FakeDocker struct {
	mu         sync.Mutex
	containers []engine.ContainerSummary
	Files      map[string]map[string]string // containernaam → pad → inhoud
	Modes      map[string]string            // containernaam+pad → chmod-modus
	// Handler beantwoordt een exec (handled=false: het nepbestandssysteem of exitcode 0).
	Handler func(container string, argv []string, stdin string) (stdout, stderr string, code int, handled bool)
	IPMap   map[string]map[string]string // container-id → netwerk → IPv4
	calls   []FakeCall
	signals []string
}

// NewFakeDocker maakt een lege fake.
func NewFakeDocker() *FakeDocker {
	return &FakeDocker{Files: map[string]map[string]string{}, Modes: map[string]string{}, IPMap: map[string]map[string]string{}}
}

// Add voegt een container toe.
func (f *FakeDocker) Add(c engine.ContainerSummary) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers = append(f.containers, c)
}

// Calls geeft de execs tot nu toe.
func (f *FakeDocker) Calls() []FakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeCall(nil), f.calls...)
}

// Signals geeft "<naam> <signaal>" per Signal-aanroep.
func (f *FakeDocker) Signals() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.signals...)
}

func (f *FakeDocker) Containers(_ context.Context, labels map[string]string) ([]engine.ContainerSummary, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []engine.ContainerSummary
	for _, c := range f.containers {
		ok := true
		for k, v := range labels {
			if c.Labels[k] != v {
				ok = false
			}
		}
		if ok {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *FakeDocker) byID(id string) (engine.ContainerSummary, bool) {
	for _, c := range f.containers {
		if c.ID == id {
			return c, true
		}
	}
	return engine.ContainerSummary{}, false
}

func (f *FakeDocker) Signal(_ context.Context, id, sig string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.byID(id)
	if !ok {
		return engine.ErrNotFound
	}
	f.signals = append(f.signals, c.Name+" "+sig)
	return nil
}

func (f *FakeDocker) IPs(_ context.Context, id string) (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.IPMap[id], nil
}

func (f *FakeDocker) Exec(_ context.Context, id string, o engine.ExecIO) (engine.ExecIOResult, error) {
	var stdin string
	if o.Stdin != nil {
		b, _ := io.ReadAll(o.Stdin)
		stdin = string(b)
	}
	f.mu.Lock()
	c, ok := f.byID(id)
	if !ok || c.State != "running" {
		f.mu.Unlock()
		return engine.ExecIOResult{}, engine.ErrNotFound
	}
	f.calls = append(f.calls, FakeCall{Container: c.Name, Argv: append([]string(nil), o.Cmd...), User: o.User, Stdin: stdin})
	h := f.Handler
	f.mu.Unlock()
	if h != nil {
		if out, errOut, code, handled := h(c.Name, o.Cmd, stdin); handled {
			if o.Stdout != nil {
				_, _ = io.WriteString(o.Stdout, out)
			}
			return engine.ExecIOResult{ExitCode: code, Stderr: errOut}, nil
		}
	}
	out, errOut, code := f.fs(c.Name, o.Cmd, stdin)
	if o.Stdout != nil {
		_, _ = io.WriteString(o.Stdout, out)
	}
	return engine.ExecIOResult{ExitCode: code, Stderr: errOut}, nil
}

// args zonder opties en "--".
func plainArgs(a []string) []string {
	var out []string
	dd := false
	for _, x := range a {
		if !dd && x == "--" {
			dd = true
			continue
		}
		if !dd && strings.HasPrefix(x, "-") {
			continue
		}
		out = append(out, x)
	}
	return out
}

func (f *FakeDocker) fs(name string, argv []string, stdin string) (string, string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	files := f.Files[name]
	if files == nil {
		files = map[string]string{}
		f.Files[name] = files
	}
	if len(argv) == 0 {
		return "", "no command", 127
	}
	args := plainArgs(argv[1:])
	switch argv[0] {
	case "ls":
		if len(args) != 1 {
			return "", "usage", 2
		}
		var names []string
		for p := range files {
			if path.Dir(p) == path.Clean(args[0]) {
				names = append(names, path.Base(p))
			}
		}
		sort.Strings(names)
		return strings.Join(names, "\n") + "\n", "", 0
	case "cat":
		v, ok := files[args[0]]
		if !ok {
			return "", "cat: " + args[0] + ": No such file or directory", 1
		}
		return v, "", 0
	case "tee":
		files[args[0]] = stdin
		return stdin, "", 0
	case "chmod":
		f.Modes[name+args[1]] = args[0]
		if _, ok := files[args[1]]; !ok {
			return "", "no such file", 1
		}
		return "", "", 0
	case "chown":
		if _, ok := files[args[len(args)-1]]; !ok {
			return "", "no such file", 1
		}
		return "", "", 0
	case "mv":
		v, ok := files[args[0]]
		if !ok {
			return "", "no such file", 1
		}
		delete(files, args[0])
		files[args[1]] = v
		f.Modes[name+args[1]] = f.Modes[name+args[0]]
		return "", "", 0
	case "rm":
		for _, p := range args {
			delete(files, p)
			for q := range files {
				if strings.HasPrefix(q, p+"/") {
					delete(files, q)
				}
			}
		}
		return "", "", 0
	}
	return "", "", 0
}
