package platform

import (
	"syscall"
	"time"
	"unsafe"
)

const (
	wakeAllInput   = 0x04FF
	waitInputReady = 0x0004
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procWaitMessage = user32.NewProc("MsgWaitForMultipleObjectsEx")
	procPostMessage = user32.NewProc("PostMessageW")
)

// WaitEvents blocks until the window system has an event for the window or timeout passes (0 waits without end).
// The event stays queued for the next poll.
func WaitEvents(_ unsafe.Pointer, timeout time.Duration) {
	ms := uintptr(0xFFFFFFFF)
	if timeout > 0 {
		ms = uintptr(timeout.Milliseconds() + 1)
	}
	procWaitMessage.Call(0, 0, ms, wakeAllInput, waitInputReady)
}

// WakeEvents makes a WaitEvents in progress, or the next one, return; safe from any goroutine.
func WakeEvents(window unsafe.Pointer) {
	procPostMessage.Call(uintptr(window), 0, 0, 0)
}
