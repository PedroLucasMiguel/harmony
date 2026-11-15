//go:build !darwin

package secrets

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// fileStore is a JSON file of secrets in the settings directory that only this user can read. Each value is what the
// seal function made of it: the system's encryption where there is one, the bytes as they are where there is not.
type fileStore struct {
	mu   sync.Mutex
	seal func([]byte) ([]byte, error)
	open func([]byte) ([]byte, error)
}

func filePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Harmony v2", "secrets.json"), nil
}

func (f *fileStore) read() (map[string]string, error) {
	path, err := filePath()
	if err != nil {
		return nil, err
	}
	items := map[string]string{}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return items, nil
	}
	if err != nil {
		return nil, err
	}
	return items, json.Unmarshal(data, &items)
}

func (f *fileStore) write(items map[string]string) error {
	path, err := filePath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (f *fileStore) get(key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	items, err := f.read()
	if err != nil {
		return nil, err
	}
	text, ok := items[key]
	if !ok {
		return nil, ErrNotFound
	}
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, err
	}
	return f.open(raw)
}

func (f *fileStore) set(key string, value []byte) error {
	sealed, err := f.seal(value)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	items, err := f.read()
	if err != nil {
		items = map[string]string{}
	}
	items[key] = base64.StdEncoding.EncodeToString(sealed)
	return f.write(items)
}

func (f *fileStore) remove(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	items, err := f.read()
	if err != nil {
		return err
	}
	if _, ok := items[key]; !ok {
		return nil
	}
	delete(items, key)
	return f.write(items)
}
