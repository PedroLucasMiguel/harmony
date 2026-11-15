package debuglog

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	sampleEvery = 2 * time.Second
	maxBytes    = 64 << 20
)

type sink struct {
	mu    sync.Mutex
	file  *os.File
	path  string
	bytes int
	stop  chan struct{}
}

func (s *sink) write(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil || s.bytes > maxBytes {
		return
	}
	s.bytes += len(text)
	_, _ = s.file.WriteString(text)
}

// Dir is the folder the log files go in.
func Dir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "Harmony v2", "logs")
}

// Start begins a new log file holding the ring so far, then every line and a sample of the machine every two seconds; it returns the file's path.
func Start() (string, error) {
	log.mu.Lock()
	running := log.sink
	log.mu.Unlock()
	if running != nil {
		return running.path, nil
	}
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(Dir(), "harmony-debug-"+time.Now().Format("20060102-150405")+".txt")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return "", err
	}
	s := &sink{file: file, path: path, stop: make(chan struct{})}
	s.write(Text())
	log.mu.Lock()
	log.sink = s
	log.mu.Unlock()
	go sample(s)
	return path, nil
}

// Stop closes the log file.
func Stop() {
	log.mu.Lock()
	s := log.sink
	log.sink = nil
	log.mu.Unlock()
	if s == nil {
		return
	}
	close(s.stop)
	s.write(entry{at: time.Now(), kind: "LOG", text: "stopped by the user"}.format())
	s.mu.Lock()
	_ = s.file.Close()
	s.file = nil
	s.mu.Unlock()
}

// Path is the file being written, or empty when no log is on.
func Path() string {
	log.mu.Lock()
	defer log.mu.Unlock()
	if log.sink == nil {
		return ""
	}
	return log.sink.path
}

// Save writes the ring, with its header, to a file.
func Save(path string) error { return os.WriteFile(path, []byte(Text()), 0o600) }

func sample(s *sink) {
	tick := time.NewTicker(sampleEvery)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			Writef("SYS", "heap=%dMB sys=%dMB goroutines=%d gc=%d", m.HeapAlloc>>20, m.Sys>>20, runtime.NumGoroutine(), m.NumGC)
		}
	}
}

func header() string {
	var b strings.Builder
	b.WriteString("Harmony v2 debug log\n")
	fmt.Fprintf(&b, "time      %s\n", time.Now().Format(time.RFC1123))
	fmt.Fprintf(&b, "system    %s %s  cpus=%d  %s\n", runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), runtime.Version())
	b.WriteString("\nLines are:  [time] KIND  text. Nothing here names an account, address or server.\n\n")
	return b.String()
}
