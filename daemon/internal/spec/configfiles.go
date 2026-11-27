package spec

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ContainerHome is de data-map in de container.
const ContainerHome = "/home/container"

// CleanRel maakt van een pad (relatief, of absoluut onder /home/container) een schoon
// relatief pad binnen de data-map. `..` kan niet ontsnappen.
func CleanRel(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("leeg pad")
	}
	if strings.ContainsRune(p, 0) {
		return "", errors.New("invalid character in path")
	}
	if p == ContainerHome || strings.HasPrefix(p, ContainerHome+"/") {
		p = strings.TrimPrefix(p, ContainerHome)
	}
	c := path.Clean("/" + p)
	if c == "/" {
		return "", errors.New("path points to the root directory")
	}
	return strings.TrimPrefix(c, "/"), nil
}

// SafePath geeft het absolute pad van rel binnen root. Symlinks onderweg of als eindpunt
// worden geweigerd, zodat niets buiten root geschreven kan worden. Ontbrekende mappen
// worden aangemaakt met eigenaar uid/gid.
func SafePath(root, rel string, uid, gid int) (string, error) {
	rel, err := CleanRel(rel)
	if err != nil {
		return "", err
	}
	parts := strings.Split(rel, "/")
	cur := root
	for i, part := range parts {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		last := i == len(parts)-1
		switch {
		case errors.Is(err, os.ErrNotExist):
			if last {
				return cur, nil
			}
			if err := os.Mkdir(cur, 0o755); err != nil {
				return "", err
			}
			_ = os.Lchown(cur, uid, gid)
		case err != nil:
			return "", err
		case fi.Mode()&os.ModeSymlink != 0:
			return "", fmt.Errorf("%s is a symlink", rel)
		case !last && !fi.IsDir():
			return "", fmt.Errorf("%s: not a directory", strings.Join(parts[:i+1], "/"))
		case last && fi.IsDir():
			return "", fmt.Errorf("%s is a directory", rel)
		}
	}
	return cur, nil
}

// ApplyConfigFiles werkt de config-bestanden bij in root (de data-map van de server).
func ApplyConfigFiles(root string, files []ConfigFile, vars map[string]string, uid, gid int) error {
	for _, f := range files {
		set := make(map[string]string, len(f.Set))
		for k, v := range f.Set {
			set[k] = Expand(v, vars)
		}
		p, err := SafePath(root, f.Path, uid, gid)
		if err != nil {
			return fmt.Errorf("config %s: %w", f.Path, err)
		}
		old, err := os.ReadFile(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("config %s: %w", f.Path, err)
		}
		err = nil
		var out []byte
		switch f.Format {
		case "properties":
			out = UpdateProperties(old, set)
		case "yaml":
			out, err = UpdateYAML(old, set)
		case "json":
			out, err = UpdateJSON(old, set)
		case "toml":
			out = UpdateTOML(old, set)
		default:
			err = fmt.Errorf("onbekend formaat %q", f.Format)
		}
		if err != nil {
			return fmt.Errorf("config %s: %w", f.Path, err)
		}
		if bytes.Equal(out, old) {
			continue
		}
		if err := writeFileAtomic(p, out, uid, gid); err != nil {
			return fmt.Errorf("config %s: %w", f.Path, err)
		}
	}
	return nil
}

func writeFileAtomic(p string, data []byte, uid, gid int) error {
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(p); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".panel-cfg-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	_ = os.Chmod(tmp.Name(), mode)
	_ = os.Lchown(tmp.Name(), uid, gid)
	return os.Rename(tmp.Name(), p)
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// UpdateProperties zet key=value in een .properties-bestand; andere regels blijven staan.
func UpdateProperties(old []byte, set map[string]string) []byte {
	var out bytes.Buffer
	seen := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(old))
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		t := strings.TrimSpace(line)
		if t != "" && t[0] != '#' && t[0] != '!' {
			key := t
			if i := strings.IndexAny(t, "=:"); i >= 0 {
				key = strings.TrimSpace(t[:i])
			}
			if v, ok := set[key]; ok {
				if seen[key] {
					continue // dubbele sleutel: alleen de eerste houden
				}
				seen[key] = true
				line = key + "=" + v
			}
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	for _, k := range sortedKeys(set) {
		if !seen[k] {
			out.WriteString(k + "=" + set[k] + "\n")
		}
	}
	return out.Bytes()
}

// UpdateYAML zet geneste sleutels (met punten) in een YAML-document.
func UpdateYAML(old []byte, set map[string]string) ([]byte, error) {
	var doc yaml.Node
	if len(bytes.TrimSpace(old)) > 0 {
		if err := yaml.Unmarshal(old, &doc); err != nil {
			return nil, err
		}
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("document is not a mapping")
	}
	for _, k := range sortedKeys(set) {
		node := doc.Content[0]
		parts := strings.Split(k, ".")
		for i, part := range parts {
			var child *yaml.Node
			for j := 0; j+1 < len(node.Content); j += 2 {
				if node.Content[j].Value == part {
					child = node.Content[j+1]
					break
				}
			}
			last := i == len(parts)-1
			if child == nil {
				child = &yaml.Node{Kind: yaml.MappingNode}
				node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: part}, child)
			}
			if last {
				*child = *yamlScalar(set[k])
			} else if child.Kind != yaml.MappingNode {
				*child = yaml.Node{Kind: yaml.MappingNode}
			}
			node = child
		}
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, err
	}
	_ = enc.Close()
	return buf.Bytes(), nil
}

func yamlScalar(v string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.ScalarNode, Value: v}
	var probe any
	if err := yaml.Unmarshal([]byte(v), &probe); err == nil {
		switch probe.(type) {
		case bool, int, int64, uint64, float64:
			return n // bool/getal: plain laten
		}
	}
	n.Tag = "!!str"
	return n
}

// UpdateJSON zet geneste sleutels (met punten) in een JSON-object. Waarden die een
// JSON-literal zijn (true, false, null, getallen) worden als zodanig geschreven.
func UpdateJSON(old []byte, set map[string]string) ([]byte, error) {
	root := map[string]any{}
	if len(bytes.TrimSpace(old)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(old))
		dec.UseNumber()
		if err := dec.Decode(&root); err != nil {
			return nil, err
		}
	}
	for _, k := range sortedKeys(set) {
		parts := strings.Split(k, ".")
		node := root
		for _, part := range parts[:len(parts)-1] {
			next, ok := node[part].(map[string]any)
			if !ok {
				next = map[string]any{}
				node[part] = next
			}
			node = next
		}
		v := set[k]
		var lit any
		if err := json.Unmarshal([]byte(v), &lit); err == nil {
			switch lit.(type) {
			case bool, float64, nil:
				node[parts[len(parts)-1]] = json.RawMessage(v)
				continue
			}
		}
		node[parts[len(parts)-1]] = v
	}
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}
