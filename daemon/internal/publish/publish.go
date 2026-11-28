// Package publish zet een staging-kopie van een website over de bestanden van de productiesite
// ("publiceren"), in stappen die het panel aanstuurt:
//
//  1. Prepare: lege werkmap `.panel-publish-<id>/new` in de datamap van productie; het panel vult hem
//     (tar-stroom of kopie op dezelfde node). Productie blijft intussen draaien.
//  2. Swap: uitgesloten paden uit new weggooien; alle bestaande namen op het hoogste niveau (behalve
//     `.panel-*`) naar `.panel-publish-<id>/old`; de inhoud van new op hun plek; daarna de uitgesloten
//     paden uit old terug op hun plek (productie houdt zijn eigen versie). Elke stap staat in
//     `state.json`, zodat Rollback ook na een daemon-herstart precies weet wat terug moet.
//  3. Finish (oude versie weg) of Rollback (alles terug zoals het was).
//
// Alles loopt via files.Root (RESOLVE_BENEATH): de site zelf kan de werkmap niet gebruiken om buiten
// zijn data te komen. Namen die met `.panel-` beginnen (git-deploy, werkmappen, eenmalige setup)
// worden nooit verplaatst of overgenomen.
package publish

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strconv"
	"strings"

	"panel/daemon/internal/files"
)

// Prefix van namen die het panel/de daemon zelf beheren.
const Prefix = ".panel-"

// ErrNotPrepared: er is geen werkmap voor deze publicatie.
var ErrNotPrepared = errors.New("publish not prepared")

// ErrBadPattern: een uitsluiting is ongeldig.
var ErrBadPattern = errors.New("invalid exclude pattern")

// Dir is de werkmap van publicatie id (relatief aan de datamap).
func Dir(id int64) string { return Prefix + "publish-" + strconv.FormatInt(id, 10) }

// Internal meldt of een naam op het hoogste niveau door het panel beheerd wordt.
func Internal(name string) bool { return strings.HasPrefix(name, Prefix) }

type state struct {
	Phase string   `json:"phase"` // swapping, swapped
	Live  []string `json:"live"`  // namen die naar old verplaatst worden/zijn
	Moved []string `json:"moved"` // uitgesloten paden die uit old terug in de datamap staan
}

// ---------- uitsluitingen ----------

type pattern struct {
	glob     string
	anchored bool
	dirOnly  bool
}

// Patterns is een gecompileerde lijst uitsluitingen.
type Patterns []pattern

// Compile controleert en vertaalt uitsluitingen. Regels (zoals .gitignore, zonder `**` en `!`):
//   - zonder `/` (behalve aan het eind): naam op elke diepte (`wp-config.php`, `.env`, `*.log`);
//   - met `/`: pad vanaf de root (`public/wp-content/uploads`, `/config/*.php`);
//   - eindigt op `/`: alleen mappen; `*`, `?` en `[...]` zoals path.Match (niet over `/`).
func Compile(list []string) (Patterns, error) {
	if len(list) > 100 {
		return nil, fmt.Errorf("%w: at most 100 patterns", ErrBadPattern)
	}
	out := make(Patterns, 0, len(list))
	for _, raw := range list {
		p := strings.TrimSpace(raw)
		if p == "" || len(p) > 512 || strings.ContainsRune(p, 0) || strings.Contains(p, "\\") {
			return nil, fmt.Errorf("%w: %q", ErrBadPattern, raw)
		}
		pt := pattern{}
		if strings.HasSuffix(p, "/") {
			pt.dirOnly = true
			p = strings.TrimRight(p, "/")
		}
		if strings.HasPrefix(p, "/") {
			pt.anchored = true
			p = strings.TrimLeft(p, "/")
		}
		if strings.Contains(p, "/") {
			pt.anchored = true
		}
		for _, seg := range strings.Split(p, "/") {
			if seg == "" || seg == "." || seg == ".." || strings.Contains(seg, "**") {
				return nil, fmt.Errorf("%w: %q", ErrBadPattern, raw)
			}
		}
		if _, err := path.Match(p, ""); err != nil {
			return nil, fmt.Errorf("%w: %q", ErrBadPattern, raw)
		}
		pt.glob = p
		out = append(out, pt)
	}
	return out, nil
}

// Match meldt of het relatieve pad rel (zonder leidende `/`) uitgesloten is.
func (ps Patterns) Match(rel string, isDir bool) bool {
	for _, p := range ps {
		if p.dirOnly && !isDir {
			continue
		}
		subject := rel
		if !p.anchored {
			subject = path.Base(rel)
		}
		if ok, _ := path.Match(p.glob, subject); ok {
			return true
		}
	}
	return false
}

// ---------- hulpjes ----------

func join(a, b string) string {
	if a == "" || a == "." {
		return b
	}
	return a + "/" + b
}

func exists(root *files.Root, rel string) (fs.FileInfo, bool, error) {
	fi, err := root.Lstat(files.APIPath(rel))
	if errors.Is(err, files.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return fi, true, nil
}

func realDir(fi fs.FileInfo) bool { return fi.Mode()&fs.ModeSymlink == 0 && fi.IsDir() }

// names geeft de namen in map rel (geen symlinks volgen: rel moet een echte map zijn).
func names(root *files.Root, rel string) ([]fs.FileInfo, error) {
	return root.ListInfo(files.APIPath(rel))
}

// ensureDirs maakt van rel en al zijn tussenmappen echte mappen; staat er een bestand of symlink
// in de weg, dan gaat dat weg (zoals de shared paths van git-deploy).
func ensureDirs(root *files.Root, rel string) error {
	if rel == "." || rel == "" {
		return nil
	}
	cur := ""
	for _, seg := range strings.Split(rel, "/") {
		cur = join(cur, seg)
		fi, ok, err := exists(root, cur)
		if err != nil {
			return err
		}
		if ok && realDir(fi) {
			continue
		}
		if ok {
			if err := root.RemoveAll(files.APIPath(cur)); err != nil {
				return err
			}
		}
		if err := root.MkdirAll(cur); err != nil {
			return err
		}
	}
	return nil
}

func (st *state) save(root *files.Root, id int64) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	p := files.APIPath(Dir(id) + "/state.json.tmp")
	f, err := root.Open(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if serr := f.Sync(); err == nil {
		err = serr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return root.RenameReplace(p, files.APIPath(Dir(id)+"/state.json"))
}

func load(root *files.Root, id int64) (*state, error) {
	f, _, err := root.OpenRead(files.APIPath(Dir(id) + "/state.json"))
	if errors.Is(err, files.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st state
	if err := json.NewDecoder(io.LimitReader(f, 16<<20)).Decode(&st); err != nil {
		return nil, fmt.Errorf("publish state: %w", err)
	}
	return &st, nil
}

// ---------- stappen ----------

// Prepare maakt een lege werkmap (een oude met hetzelfde id gaat eerst weg) en geeft het pad (relatief)
// van de map waarin de nieuwe versie moet komen.
func Prepare(root *files.Root, id int64) (string, error) {
	d := Dir(id)
	if err := root.RemoveAll(files.APIPath(d)); err != nil {
		return "", err
	}
	if err := root.MkdirAll(d + "/new"); err != nil {
		return "", err
	}
	return d + "/new", nil
}

// Swap zet de inhoud van de werkmap op de plek van de huidige bestanden; uitgesloten paden houden de
// versie van productie (bestaat die niet, dan komt de nieuwe versie ook niet). Mislukt het, dan wordt
// alles teruggezet (Rollback) en komt de fout terug.
func Swap(root *files.Root, id int64, ex Patterns, logf func(string)) (err error) {
	d := Dir(id)
	fi, ok, err := exists(root, d+"/new")
	if err != nil {
		return err
	}
	if !ok || !realDir(fi) {
		return ErrNotPrepared
	}
	if st, err := load(root, id); err != nil {
		return err
	} else if st != nil {
		return fmt.Errorf("publish %d already swapped (phase %s)", id, st.Phase)
	}
	defer func() {
		if err != nil {
			if rerr := Rollback(root, id); rerr != nil {
				logf("rollback failed: " + rerr.Error())
				err = fmt.Errorf("%w (rollback failed: %v)", err, rerr)
			}
		}
	}()

	// 1. De nieuwe versie: interne namen en uitgesloten paden eruit.
	if err := prune(root, d+"/new", "", ex); err != nil {
		return fmt.Errorf("excludes: %w", err)
	}

	// 2. Huidige namen opschrijven, dan naar old.
	cur, err := names(root, ".")
	if err != nil {
		return err
	}
	st := &state{Phase: "swapping"}
	for _, e := range cur {
		if !Internal(e.Name()) {
			st.Live = append(st.Live, e.Name())
		}
	}
	if err := root.MkdirAll(d + "/old"); err != nil {
		return err
	}
	if err := st.save(root, id); err != nil {
		return err
	}
	for _, n := range st.Live {
		if err := root.Rename(files.APIPath(n), files.APIPath(d+"/old/"+n)); err != nil {
			return fmt.Errorf("moving %s aside: %w", n, err)
		}
	}

	// 3. Nieuwe versie op zijn plek.
	next, err := names(root, d+"/new")
	if err != nil {
		return err
	}
	for _, e := range next {
		if err := root.Rename(files.APIPath(d+"/new/"+e.Name()), files.APIPath(e.Name())); err != nil {
			return fmt.Errorf("publishing %s: %w", e.Name(), err)
		}
	}

	// 4. Uitgesloten paden van productie terugzetten.
	var keep []string
	if err := collect(root, d+"/old", "", ex, &keep); err != nil {
		return fmt.Errorf("excludes: %w", err)
	}
	for _, rel := range keep {
		if dir := path.Dir(rel); dir != "." {
			if err := ensureDirs(root, dir); err != nil {
				return fmt.Errorf("keeping %s: %w", rel, err)
			}
		}
		if err := root.RemoveAll(files.APIPath(rel)); err != nil {
			return err
		}
		st.Moved = append(st.Moved, rel)
		if err := st.save(root, id); err != nil {
			return err
		}
		if err := root.Rename(files.APIPath(d+"/old/"+rel), files.APIPath(rel)); err != nil {
			return fmt.Errorf("keeping %s: %w", rel, err)
		}
		logf("kept " + files.APIPath(rel))
	}
	st.Phase = "swapped"
	return st.save(root, id)
}

// prune verwijdert uit base (de nieuwe versie) de interne namen op het hoogste niveau en alles wat
// uitgesloten is.
func prune(root *files.Root, base, rel string, ex Patterns) error {
	list, err := names(root, join(base, rel))
	if err != nil {
		return err
	}
	for _, e := range list {
		r := join(rel, e.Name())
		dir := realDir(e)
		if (rel == "" && Internal(e.Name())) || ex.Match(r, dir) {
			if err := root.RemoveAll(files.APIPath(join(base, r))); err != nil {
				return err
			}
			continue
		}
		if dir {
			if err := prune(root, base, r, ex); err != nil {
				return err
			}
		}
	}
	return nil
}

// collect zoekt in base (de oude versie) de uitgesloten paden (niet dieper dan een treffer).
func collect(root *files.Root, base, rel string, ex Patterns, out *[]string) error {
	if len(ex) == 0 {
		return nil
	}
	list, err := names(root, join(base, rel))
	if err != nil {
		return err
	}
	for _, e := range list {
		r := join(rel, e.Name())
		dir := realDir(e)
		if ex.Match(r, dir) {
			*out = append(*out, r)
			continue
		}
		if dir {
			if err := collect(root, base, r, ex, out); err != nil {
				return err
			}
		}
	}
	return nil
}

// Rollback zet productie terug zoals hij vóór Swap was en ruimt de werkmap op. Zonder Swap (of als er
// niets is) ruimt hij alleen op. Idempotent.
func Rollback(root *files.Root, id int64) error {
	d := Dir(id)
	st, err := load(root, id)
	if err != nil {
		return err
	}
	if st != nil {
		// Teruggezette uitgesloten paden weer in old (omgekeerde volgorde).
		for i := len(st.Moved) - 1; i >= 0; i-- {
			rel := st.Moved[i]
			if _, inOld, err := exists(root, d+"/old/"+rel); err != nil {
				return err
			} else if inOld {
				continue
			}
			if _, ok, err := exists(root, rel); err != nil {
				return err
			} else if !ok {
				continue
			}
			if err := ensureDirs(root, path.Dir(d+"/old/"+rel)); err != nil {
				return err
			}
			if err := root.Rename(files.APIPath(rel), files.APIPath(d+"/old/"+rel)); err != nil {
				return fmt.Errorf("restoring %s: %w", rel, err)
			}
		}
		live := map[string]bool{}
		for _, n := range st.Live {
			live[n] = true
		}
		cur, err := names(root, ".")
		if err != nil {
			return err
		}
		for _, e := range cur {
			if Internal(e.Name()) || live[e.Name()] {
				continue
			}
			if err := root.RemoveAll(files.APIPath(e.Name())); err != nil {
				return err
			}
		}
		for _, n := range st.Live {
			if _, inOld, err := exists(root, d+"/old/"+n); err != nil {
				return err
			} else if !inOld {
				continue // nooit verplaatst
			}
			if err := root.RemoveAll(files.APIPath(n)); err != nil {
				return err
			}
			if err := root.Rename(files.APIPath(d+"/old/"+n), files.APIPath(n)); err != nil {
				return fmt.Errorf("restoring %s: %w", n, err)
			}
		}
	}
	return root.RemoveAll(files.APIPath(d))
}

// Finish ruimt de werkmap (met de oude versie) op na een geslaagde publicatie.
func Finish(root *files.Root, id int64) error {
	return root.RemoveAll(files.APIPath(Dir(id)))
}

// Swapped meldt of publicatie id omgewisseld is (voor de status).
func Swapped(root *files.Root, id int64) (bool, error) {
	st, err := load(root, id)
	if err != nil || st == nil {
		return false, err
	}
	return st.Phase == "swapped", nil
}
