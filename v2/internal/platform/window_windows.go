package platform

import "unsafe"

var (
	procGetCursorPos      = user32.NewProc("GetCursorPos")
	procSetWindowPos      = user32.NewProc("SetWindowPos")
	procGetWindowRect     = user32.NewProc("GetWindowRect")
	procMonitorFromWindow = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfo    = user32.NewProc("GetMonitorInfoW")
)

const (
	swpNoZOrder    = 0x0004
	swpNoActivate  = 0x0010
	monitorNearest = 2
)

type point struct{ x, y int32 }

type rect struct{ left, top, right, bottom int32 }

// monitorInfo is MONITORINFO.
type monitorInfo struct {
	size    uint32
	monitor rect
	work    rect
	flags   uint32
}

// CursorPosition is the pointer's place on the screen, in pixels. A window that moves under the pointer cannot use the
// place the window system reports inside it: that one lags the window by a message.
func CursorPosition() (x, y int, ok bool) {
	var p point
	if r, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&p))); r == 0 {
		return 0, 0, false
	}
	return int(p.x), int(p.y), true
}

// SetWindowRect moves and sizes the window in one step, so that no frame shows it in between.
func SetWindowRect(window unsafe.Pointer, x, y, w, h int) bool {
	r, _, _ := procSetWindowPos.Call(uintptr(window), 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), swpNoZOrder|swpNoActivate)
	return r != 0
}

// WorkArea is the part of the screen of the window's monitor that the taskbar leaves free.
func WorkArea(window unsafe.Pointer) (x, y, w, h int, ok bool) {
	mon, _, _ := procMonitorFromWindow.Call(uintptr(window), monitorNearest)
	if mon == 0 {
		return 0, 0, 0, 0, false
	}
	info := monitorInfo{size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if r, _, _ := procGetMonitorInfo.Call(mon, uintptr(unsafe.Pointer(&info))); r == 0 {
		return 0, 0, 0, 0, false
	}
	return int(info.work.left), int(info.work.top), int(info.work.right - info.work.left), int(info.work.bottom - info.work.top), true
}

// WindowRect is the window's place and size on the screen, in pixels.
func WindowRect(window unsafe.Pointer) (x, y, w, h int, ok bool) {
	var r rect
	if res, _, _ := procGetWindowRect.Call(uintptr(window), uintptr(unsafe.Pointer(&r))); res == 0 {
		return 0, 0, 0, 0, false
	}
	return int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top), true
}
