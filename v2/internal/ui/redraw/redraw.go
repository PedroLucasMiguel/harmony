// Package redraw lets anything ask for the next frame, so the window can sleep while nothing changes.
package redraw

import (
	"sync/atomic"
	"time"
)

var (
	requested atomic.Bool
	deadline  atomic.Int64
	sleeping  atomic.Bool
	waker     atomic.Pointer[func()]
)

// Request asks for a frame as soon as possible; safe from any goroutine.
func Request() {
	requested.Store(true)
	Wake()
}

// After asks for a frame no later than d from now; the earliest ask wins until the next frame.
func After(d time.Duration) {
	at := time.Now().Add(d).UnixNano()
	for {
		current := deadline.Load()
		if current != 0 && current <= at {
			return
		}
		if deadline.CompareAndSwap(current, at) {
			Wake()
			return
		}
	}
}

// Take reports whether a frame was asked for, and clears the asks.
func Take() bool {
	asked := requested.Swap(false)
	due := deadline.Load()
	if due != 0 && due <= time.Now().UnixNano() {
		deadline.Store(0)
		return true
	}
	return asked
}

// SetWaker installs what interrupts the window's wait for events; the frame loop sets it once before it starts.
func SetWaker(wake func()) { waker.Store(&wake) }

// Wake interrupts the frame loop if it is waiting for events; safe from any goroutine.
func Wake() {
	if !sleeping.Load() {
		return
	}
	if wake := waker.Load(); wake != nil {
		(*wake)()
	}
}

// Sleep lets the frame loop wait for events with wait, which is told how long a frame may be left out, or 0 for no deadline.
// It does not call wait when a frame is already asked for.
func Sleep(wait func(time.Duration)) {
	sleeping.Store(true)
	defer sleeping.Store(false)
	if requested.Load() {
		return
	}
	var left time.Duration
	if due := deadline.Load(); due != 0 {
		if left = time.Duration(due - time.Now().UnixNano()); left <= 0 {
			return
		}
	}
	wait(left)
}
