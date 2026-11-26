// Package store schrijft de daemon-staat atomisch naar schijf.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// WriteJSON schrijft v als JSON naar p via een tijdelijk bestand + fsync + rename.
func WriteJSON(p string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return err
	}
	if d, err := os.Open(filepath.Dir(p)); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// ReadJSON leest p in v. Bestaat het bestand niet, dan os.ErrNotExist.
func ReadJSON(p string, v any) error {
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
