// Package idle says how long the person has gone without touching the keyboard or the mouse, anywhere on the computer.
package idle

import (
	"sync"
	"time"

	"github.com/ebitengine/purego"
)

const (
	combinedSession = 0
	anyInputEvent   = 0xFFFFFFFF
)

var seconds struct {
	once sync.Once
	call func(state, kind uint32) float64
}

// Since is the time since the last key or mouse event; ok is false when this system cannot say.
func Since() (d time.Duration, ok bool) {
	seconds.once.Do(func() {
		lib, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err == nil {
			purego.RegisterLibFunc(&seconds.call, lib, "CGEventSourceSecondsSinceLastEventType")
		}
	})
	if seconds.call == nil {
		return 0, false
	}
	return time.Duration(seconds.call(combinedSession, anyInputEvent) * float64(time.Second)), true
}
