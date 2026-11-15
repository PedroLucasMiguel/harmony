package music

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultLimit is how much of the tracks played is kept on disk once they have been heard.
const DefaultLimit = 256 << 20

// Fetch writes a stored file to w.
type Fetch func(ctx context.Context, hash string, w io.Writer) error

// Cache keeps the compressed files of tracks in a directory, and lets go of the ones used longest ago when there are too many.
type Cache struct {
	Dir   string
	Limit int64
	Fetch Fetch

	mu       sync.Mutex
	inflight map[string]*download
	parts    atomic.Uint64
}

type download struct {
	done chan struct{}
	err  error
}

// DefaultDir is where tracks are kept: under the system's cache directory.
func DefaultDir() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "Harmony v2", "music")
}

func validHash(hash string) bool {
	if len(hash) < 16 || len(hash) > 128 {
		return false
	}
	for _, r := range hash {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func (c *Cache) path(hash string) string { return filepath.Join(c.Dir, hash) }

// Have is the file's place on disk when it is already there, and counts as a use of it.
func (c *Cache) Have(hash string) (string, bool) {
	if !validHash(hash) {
		return "", false
	}
	path := c.path(hash)
	if _, err := os.Stat(path); err != nil {
		return "", false
	}
	now := time.Now()
	_ = os.Chtimes(path, now, now)
	return path, true
}

// Ensure is the file's place on disk, fetched first when it is not there; it waits for the fetch, and many callers for one file share it.
func (c *Cache) Ensure(ctx context.Context, hash string) (string, error) {
	if !validHash(hash) {
		return "", fmt.Errorf("bad file name %q", hash)
	}
	if path, ok := c.Have(hash); ok {
		return path, nil
	}
	c.mu.Lock()
	job := c.inflight[hash]
	if job == nil {
		if c.inflight == nil {
			c.inflight = map[string]*download{}
		}
		job = &download{done: make(chan struct{})}
		c.inflight[hash] = job
		go c.run(hash, job)
	}
	c.mu.Unlock()
	select {
	case <-job.done:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if job.err != nil {
		return "", job.err
	}
	return c.path(hash), nil
}

func (c *Cache) run(hash string, job *download) {
	job.err = c.store(hash)
	c.mu.Lock()
	delete(c.inflight, hash)
	c.mu.Unlock()
	close(job.done)
}

// store fetches into a file of its own name and renames it in place, so that a half-loaded file is never taken for a track.
func (c *Cache) store(hash string) error {
	if c.Fetch == nil {
		return errors.New("no way to fetch tracks")
	}
	if err := os.MkdirAll(c.Dir, 0o755); err != nil {
		return err
	}
	part := fmt.Sprintf("%s.%d.%d.part", c.path(hash), os.Getpid(), c.parts.Add(1))
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	err = c.Fetch(ctx, hash, f)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(part, c.path(hash))
	}
	if err != nil {
		_ = os.Remove(part)
	}
	return err
}

// Trim deletes the files used longest ago until the rest fit in Limit; the ones in keep are not touched.
func (c *Cache) Trim(keep map[string]bool) {
	limit := c.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	entries, err := os.ReadDir(c.Dir)
	if err != nil {
		return
	}
	type file struct {
		name string
		size int64
		used time.Time
	}
	var files []file
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || e.IsDir() || !validHash(e.Name()) {
			continue
		}
		files = append(files, file{e.Name(), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].used.Before(files[j].used) })
	for _, f := range files {
		if total <= limit {
			return
		}
		if keep[f.name] {
			continue
		}
		if os.Remove(filepath.Join(c.Dir, f.name)) == nil {
			total -= f.size
		}
	}
}
