package deploy

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"panel/daemon/internal/files"
)

// prefixes geeft "a", "a/b", "a/b/c" voor "a/b/c".
func prefixes(rel string) []string {
	parts := strings.Split(rel, "/")
	out := make([]string, len(parts))
	for i := range parts {
		out[i] = strings.Join(parts[:i+1], "/")
	}
	return out
}

func join(a, b string) string {
	if a == "." || a == "" {
		return b
	}
	if b == "." || b == "" {
		return a
	}
	return a + "/" + b
}

// kind: "" (bestaat niet), "dir" (echte map), "other" (bestand, symlink, …).
func kind(root *files.Root, rel string) (string, error) {
	fi, err := root.Lstat(files.APIPath(rel))
	if errors.Is(err, files.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if fi.Mode()&fs.ModeSymlink == 0 && fi.IsDir() {
		return "dir", nil
	}
	return "other", nil
}

// realDir controleert dat rel en al zijn tussenmappen echte mappen zijn (geen symlinks), zodat
// omwisselen precies deze map raakt. missingOK: de laatste mag ontbreken.
func realDir(root *files.Root, rel string, missingOK bool) (exists bool, err error) {
	if rel == "." {
		return true, nil
	}
	ps := prefixes(rel)
	for i, p := range ps {
		k, err := kind(root, p)
		if err != nil {
			return false, err
		}
		switch {
		case k == "dir":
		case k == "" && i == len(ps)-1 && missingOK:
			return false, nil
		case k == "":
			return false, fmt.Errorf("%s does not exist", files.APIPath(p))
		default:
			return false, fmt.Errorf("%s is not a folder (or is a symlink)", files.APIPath(p))
		}
	}
	return true, nil
}

type moved struct{ from, to string }

// exchange is vervangbaar in tests (om een mislukte wissel na te bootsen).
var exchange = func(r *files.Root, a, b string) error { return r.Exchange(a, b) }

// publish zet src (een map binnen de serverdata) op de plek van target. Gedeelde paden
// (relatief aan target) worden eerst uit de huidige versie in src gezet, daarna wisselt
// renameat2(RENAME_EXCHANGE) beide mappen in één keer om; de oude versie staat dan op src.
// Faalt iets, dan wordt alles teruggezet en blijft target zoals het was.
func publish(root *files.Root, src, target string, shared []string, logf func(string)) (err error) {
	if _, err := realDir(root, src, false); err != nil {
		return fmt.Errorf("published folder: %w", err)
	}
	if parent := path.Dir(target); parent != "." {
		ok, err := realDir(root, parent, true)
		if err != nil {
			return fmt.Errorf("target folder: %w", err)
		}
		if !ok {
			if err := root.MkdirAll(parent); err != nil {
				return fmt.Errorf("target folder: %w", err)
			}
			if _, err := realDir(root, parent, false); err != nil {
				return fmt.Errorf("target folder: %w", err)
			}
		}
	}
	live, err := realDir(root, target, true)
	if err != nil {
		return fmt.Errorf("target folder: %w", err)
	}
	var done []moved
	defer func() {
		if err == nil {
			return
		}
		for i := len(done) - 1; i >= 0; i-- {
			if rerr := root.Rename(files.APIPath(done[i].to), files.APIPath(done[i].from)); rerr != nil {
				logf(fmt.Sprintf("restoring %s failed: %v", files.APIPath(done[i].from), rerr))
			}
		}
	}()
	if live {
		for _, p := range shared {
			from, to := join(target, p), join(src, p)
			if dir := path.Dir(p); dir != "." {
				if ok, _ := realDir(root, join(target, dir), true); !ok {
					continue // niets te bewaren (of een symlink in het pad: niet volgen)
				}
			}
			k, err := kind(root, from)
			if err != nil {
				return err
			}
			if k == "" {
				continue
			}
			// Tussenmappen in de nieuwe versie maken; staat daar een bestand of symlink, dan vervangen.
			if dir := path.Dir(p); dir != "." {
				for _, q := range prefixes(dir) {
					qq := join(src, q)
					switch k, err := kind(root, qq); {
					case err != nil:
						return err
					case k == "dir":
						continue
					case k == "other":
						if err := root.RemoveAll(files.APIPath(qq)); err != nil {
							return err
						}
					}
					if err := root.MkdirAll(qq); err != nil {
						return err
					}
				}
			}
			if err := root.RemoveAll(files.APIPath(to)); err != nil {
				return err
			}
			if err := root.Rename(files.APIPath(from), files.APIPath(to)); err != nil {
				return fmt.Errorf("keeping %s: %w", files.APIPath(p), err)
			}
			done = append(done, moved{from: from, to: to})
			logf("kept " + files.APIPath(p))
		}
		if err := exchange(root, files.APIPath(src), files.APIPath(target)); err != nil {
			return fmt.Errorf("swapping %s: %w", files.APIPath(target), err)
		}
		return nil
	}
	if err := root.Rename(files.APIPath(src), files.APIPath(target)); err != nil {
		return fmt.Errorf("moving into %s: %w", files.APIPath(target), err)
	}
	return nil
}
