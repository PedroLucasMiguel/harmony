// Package debuglog keeps the program's recent log lines in a ring that any package can write to cheaply, and can dump them, with samples of what the machine is doing, to a text file.
package debuglog

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const ringSize = 2000

type entry struct {
	at   time.Time
	kind string
	text string
}

var log struct {
	mu      sync.Mutex
	ring    [ringSize]entry
	next    int
	count   int
	version atomic.Uint64
	sink    *sink
}

// Write adds a line of the given kind (APP, NET, AUDIO ...) to the ring, and to the log file while one is on.
func Write(kind, text string) {
	e := entry{at: time.Now(), kind: kind, text: text}
	log.mu.Lock()
	log.ring[log.next] = e
	log.next = (log.next + 1) % ringSize
	log.count = min(log.count+1, ringSize)
	s := log.sink
	log.mu.Unlock()
	log.version.Add(1)
	if s != nil {
		s.write(e.format())
	}
}

// Writef is Write with a format; the text is only built when it is used.
func Writef(kind, format string, args ...any) { Write(kind, fmt.Sprintf(format, args...)) }

// Version changes whenever a line is added, so a view can redraw only then.
func Version() uint64 { return log.version.Load() }

func (e entry) format() string {
	return fmt.Sprintf("[%s] %-5s %s\n", e.at.Format("15:04:05.000"), e.kind, e.text)
}

// Lines is the lines in the ring, oldest first.
func Lines() []string {
	log.mu.Lock()
	defer log.mu.Unlock()
	lines := make([]string, 0, log.count)
	start := (log.next - log.count + ringSize) % ringSize
	for i := range log.count {
		lines = append(lines, log.ring[(start+i)%ringSize].format())
	}
	return lines
}

// Text is the header followed by the whole ring, as it is copied or saved.
func Text() string {
	var b strings.Builder
	b.WriteString(header())
	for _, line := range Lines() {
		b.WriteString(line)
	}
	return b.String()
}

// Clear empties the ring.
func Clear() {
	log.mu.Lock()
	log.next, log.count = 0, 0
	log.mu.Unlock()
	log.version.Add(1)
}
