// Package memtrim gives memory back to the system after a burst of work that left garbage behind: decoding a picture or
// parsing a font allocates many times what it keeps, and the runtime would hold on to the difference for minutes.
package memtrim

import (
	"runtime/debug"
	"sync"
	"time"
)

// settle is how long the work must be quiet before memory is given back, so that a burst of pictures is trimmed once.
const settle = 3 * time.Second

var (
	mu    sync.Mutex
	timer *time.Timer
)

// Soon asks for memory to be given back once the work has settled; safe from any goroutine and cheap to call often.
func Soon() {
	mu.Lock()
	defer mu.Unlock()
	if timer == nil {
		timer = time.AfterFunc(settle, debug.FreeOSMemory)
		return
	}
	timer.Reset(settle)
}
