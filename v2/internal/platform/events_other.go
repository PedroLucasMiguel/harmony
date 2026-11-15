//go:build !darwin && !windows

package platform

import (
	"time"
	"unsafe"
)

const pollEvery = 16 * time.Millisecond

// WaitEvents has no native wait on this system: it sleeps a frame, so a wake or an event is seen within one.
func WaitEvents(_ unsafe.Pointer, timeout time.Duration) {
	time.Sleep(pollEvery)
}

// WakeEvents does nothing: WaitEvents never sleeps for long.
func WakeEvents(_ unsafe.Pointer) {}
