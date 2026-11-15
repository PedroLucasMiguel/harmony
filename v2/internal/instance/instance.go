// Package instance keeps one Harmony per profile running: a second launch asks the first to show itself and ends.
// The two talk over a unix socket (also available on Windows 10 and later) named after the profile's folder.
package instance

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"time"
)

const dialTimeout = 500 * time.Millisecond

// Instance is the first running program; Close it at exit.
type Instance struct {
	listener net.Listener
	path     string
}

func socketPath(profile string) string {
	sum := sha256.Sum256([]byte(profile))
	return filepath.Join(os.TempDir(), "harmony2-"+hex.EncodeToString(sum[:6])+".sock")
}

// Acquire makes this the running program for the profile and returns it, or, when another is already running, asks that one to show itself and returns nil.
// A socket nobody answers on is left over from a crash and is taken over.
func Acquire(profile string) *Instance {
	path := socketPath(profile)
	if conn, err := net.DialTimeout("unix", path, dialTimeout); err == nil {
		_, _ = conn.Write([]byte("show\n"))
		conn.Close()
		return nil
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return &Instance{}
	}
	return &Instance{listener: listener, path: path}
}

// Serve calls onSecond, from its own goroutine, each time another launch asks this one to show itself.
func (i *Instance) Serve(onSecond func()) {
	if i.listener == nil {
		return
	}
	go func() {
		for {
			conn, err := i.listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
			onSecond()
		}
	}()
}

func (i *Instance) Close() {
	if i.listener != nil {
		i.listener.Close()
		_ = os.Remove(i.path)
	}
}
