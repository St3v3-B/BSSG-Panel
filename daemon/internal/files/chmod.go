package files

import (
	"errors"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// ErrBadMode: ongeldige octale modus, of setuid/setgid/sticky zonder toestemming.
var ErrBadMode = errors.New("invalid mode")

// ParseMode leest een octale modus ("644", "0755", "2775"). Speciale bits (setuid, setgid,
// sticky) mogen alleen met allowSpecial.
func ParseMode(s string, allowSpecial bool) (uint32, error) {
	if len(s) < 3 || len(s) > 4 {
		return 0, ErrBadMode
	}
	v, err := strconv.ParseUint(s, 8, 32)
	if err != nil {
		return 0, ErrBadMode
	}
	m := uint32(v)
	if m&^0o7777 != 0 {
		return 0, ErrBadMode
	}
	if m&0o7000 != 0 && !allowSpecial {
		return 0, ErrBadMode
	}
	return m, nil
}

// SetMode zet de modus van p (bestanden: mode, mappen: dirMode). Met recursive ook alles
// eronder. Symlinks worden overgeslagen en nooit gevolgd; de root zelf mag niet. Geeft het
// aantal gewijzigde objecten.
func (r *Root) SetMode(p string, mode, dirMode uint32, recursive bool) (int, error) {
	rel, err := Clean(p)
	if err != nil {
		return 0, err
	}
	if rel == "." {
		return 0, ErrBadPath
	}
	fd, err := r.openat(rel, unix.O_PATH|unix.O_NOFOLLOW, 0)
	if err != nil {
		return 0, err
	}
	n := 0
	err = chmodTree(fd, mode, dirMode, recursive, 0, &n)
	return n, err
}

// chmodTree werkt op een O_PATH-fd (eigendom: wordt gesloten). Omdat de fd naar één vast inode
// wijst, kan een verwisselde symlink er niet tussen komen.
func chmodTree(fd int, mode, dirMode uint32, recursive bool, depth int, n *int) error {
	defer unix.Close(fd)
	if depth > 512 {
		return errors.New("te diep genest")
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return mapErr(err)
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFLNK:
		return nil
	case unix.S_IFDIR:
		if recursive {
			dfd, err := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
			if err != nil {
				return mapErr(err)
			}
			d := os.NewFile(uintptr(dfd), ".")
			for {
				names, rerr := d.Readdirnames(256)
				for _, name := range names {
					cfd, err := unix.Openat(dfd, name, unix.O_PATH|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
					if err != nil {
						continue // tussendoor verwijderd
					}
					if err := chmodTree(cfd, mode, dirMode, true, depth+1, n); err != nil {
						d.Close()
						return err
					}
				}
				if rerr != nil || len(names) == 0 {
					break
				}
			}
			d.Close()
		}
		// Na de inhoud: dan blokkeert een modus zonder x het aflopen niet.
		if err := fchmodPath(fd, dirMode); err != nil {
			return err
		}
	case unix.S_IFREG:
		if err := fchmodPath(fd, mode); err != nil {
			return err
		}
	default:
		return nil // sockets, fifo's, devices: niet aanraken
	}
	*n++
	return nil
}

// fchmodPath zet de modus via /proc/self/fd (fchmod werkt niet op O_PATH-fd's). Het pad is een
// magic link naar precies dit inode; de laatste stap is geen symlink (al gecontroleerd).
func fchmodPath(fd int, mode uint32) error {
	err := unix.Fchmodat(unix.AT_FDCWD, "/proc/self/fd/"+strconv.Itoa(fd), mode, 0)
	return mapErr(err)
}
