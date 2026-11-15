// Package idle says how long the person has gone without touching the keyboard or the mouse, anywhere on the computer.
package idle

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	getLastInputInfo = windows.NewLazySystemDLL("user32.dll").NewProc("GetLastInputInfo")
	getTickCount     = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount")
)

type lastInput struct{ size, time uint32 }

// Since is the time since the last key or mouse event; ok is false when this system cannot say.
func Since() (d time.Duration, ok bool) {
	info := lastInput{size: uint32(unsafe.Sizeof(lastInput{}))}
	if r, _, _ := getLastInputInfo.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		return 0, false
	}
	now, _, _ := getTickCount.Call()
	return time.Duration(uint32(now)-info.time) * time.Millisecond, true
}
