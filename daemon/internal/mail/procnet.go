package mail

import (
	"bufio"
	"encoding/hex"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// procRoot is /proc (tests wijzen een nepmap aan).
var procRoot = "/proc"

// ProcSocket is een luisterende socket uit /proc/net/tcp met zijn inode.
type ProcSocket struct {
	Listener
	Inode string
}

// ParseProcNet leest /proc/net/tcp of tcp6 en geeft de LISTEN-sockets op deze poorten (adres, poort, inode).
func ParseProcNet(content string, v6 bool, ports []int) []ProcSocket {
	var out []ProcSocket
	sc := bufio.NewScanner(strings.NewReader(content))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 || f[3] != "0A" { // 0A = LISTEN
			continue
		}
		hostHex, portHex, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		p, err := strconv.ParseUint(portHex, 16, 16)
		if err != nil || !slices.Contains(ports, int(p)) {
			continue
		}
		addr := decodeProcAddr(hostHex, v6)
		out = append(out, ProcSocket{Listener{Addr: addr, Port: int(p)}, f[9]})
	}
	return out
}

// decodeProcAddr: /proc/net/tcp schrijft adressen als 32-bits woorden in host-volgorde (little endian).
func decodeProcAddr(h string, v6 bool) string {
	b, err := hex.DecodeString(h)
	if err != nil || (len(b) != 4 && len(b) != 16) {
		return h
	}
	for i := 0; i+4 <= len(b); i += 4 {
		b[i], b[i+1], b[i+2], b[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	a, ok := netip.AddrFromSlice(b)
	if !ok {
		return h
	}
	return a.Unmap().String()
}

// ProcListeners geeft de luisterende TCP-sockets op deze poorten, met pid en procesnaam als dat lukt (root).
func ProcListeners(ports []int) ([]Listener, error) {
	var items []ProcSocket
	var firstErr error
	read := 0
	for _, f := range []struct {
		name string
		v6   bool
	}{{"tcp", false}, {"tcp6", true}} {
		b, err := os.ReadFile(filepath.Join(procRoot, "net", f.name))
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		read++
		for _, x := range ParseProcNet(string(b), f.v6, ports) {
			items = append(items, x)
		}
	}
	if read == 0 {
		return nil, firstErr
	}
	if len(items) == 0 {
		return nil, nil
	}
	want := map[string][]int{} // "socket:[inode]" → index
	for i, it := range items {
		want["socket:["+it.Inode+"]"] = append(want["socket:["+it.Inode+"]"], i)
	}
	procs, _ := os.ReadDir(procRoot)
	for _, p := range procs {
		pid, err := strconv.Atoi(p.Name())
		if err != nil {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(procRoot, p.Name(), "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			link, err := os.Readlink(filepath.Join(procRoot, p.Name(), "fd", fd.Name()))
			if err != nil {
				continue
			}
			for _, i := range want[link] {
				if items[i].PID == 0 {
					items[i].PID = pid
					if c, err := os.ReadFile(filepath.Join(procRoot, p.Name(), "comm")); err == nil {
						items[i].Process = strings.TrimSpace(string(c))
					}
				}
			}
		}
	}
	out := make([]Listener, len(items))
	for i, it := range items {
		out[i] = it.Listener
	}
	return out, nil
}

// pidInContainer: staat het container-id in /proc/<pid>/cgroup (docker-<id>.scope of /docker/<id>)?
func pidInContainer(pid int, id string) bool {
	if len(id) < 12 {
		return false
	}
	b, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "cgroup"))
	return err == nil && strings.Contains(string(b), id)
}
