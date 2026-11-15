// Package faces turns the pictures people put on their profile into small textures: fetched once, kept on disk by hash, and
// decoded at the size they are drawn so that memory stays tiny.
package faces

import (
	"context"
	"errors"
	"image"
	"os"
	"path/filepath"
	"sync"
	"time"

	"harmony/v2/internal/ui/paint"
)

const (
	fetchTimeout = 20 * time.Second
	fetchLimit   = 3 << 20
	staleAfter   = 30 * 24 * time.Hour
)

// Fetch reads a stored file by hash, up to limit bytes.
type Fetch func(ctx context.Context, hash string, limit int64) ([]byte, error)

var pruned sync.Once

type Store struct {
	fetch Fetch
	dir   string
}

// New makes a store that fetches with fetch and keeps what it fetched under the user's cache directory.
func New(fetch Fetch) *Store {
	s := &Store{fetch: fetch}
	if base, err := os.UserCacheDir(); err == nil {
		s.dir = filepath.Join(base, "Harmony v2", "media")
		pruned.Do(func() { go prune(s.dir) })
	}
	return s
}

func prune(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > staleAfter {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// Data is the file stored under hash, from the disk cache when it is there.
func (s *Store) Data(hash string) ([]byte, error) {
	if len(hash) != 64 {
		return nil, errors.New("not a hash")
	}
	path := ""
	if s.dir != "" {
		path = filepath.Join(s.dir, hash)
		if data, err := os.ReadFile(path); err == nil {
			return data, nil
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	data, err := s.fetch(ctx, hash, fetchLimit)
	if err != nil {
		return nil, err
	}
	if path != "" && os.MkdirAll(s.dir, 0o755) == nil {
		tmp := path + ".part"
		if os.WriteFile(tmp, data, 0o644) == nil {
			os.Rename(tmp, path)
		}
	}
	return data, nil
}

// Bytes implements paint.Source: the fetch function for the file under hash.
func (s *Store) Bytes(hash string) func() ([]byte, error) {
	return func() ([]byte, error) { return s.Data(hash) }
}

// Sized implements paint.Sizer.
func (s *Store) Sized(shape paint.Shape, hash string, w, h int) func() (*image.NRGBA, error) {
	return func() (*image.NRGBA, error) {
		data, err := s.Data(hash)
		if err != nil {
			return nil, err
		}
		return Render(data, w, h, shape == paint.Round)
	}
}
