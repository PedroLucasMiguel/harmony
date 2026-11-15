// Package idle says how long the person has gone without touching the keyboard or the mouse, anywhere on the computer.
package idle

import (
	"os"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/godbus/dbus/v5"
)

// On X11 the screen saver extension keeps the time since the last input. On Wayland no program may ask that, so the
// session's IdleHint from logind is used instead: the desktop sets it when it considers the person away, which is a
// coarser answer (and some desktops never set it).

var xss struct {
	once    sync.Once
	display uintptr
	root    uintptr
	info    uintptr
	query   func(display, drawable, info uintptr) int32
}

func openXScreenSaver() bool {
	xss.once.Do(func() {
		if os.Getenv("DISPLAY") == "" {
			return
		}
		x, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		s, err := purego.Dlopen("libXss.so.1", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		var open func(name uintptr) uintptr
		var root func(display uintptr) uintptr
		var alloc func() uintptr
		purego.RegisterLibFunc(&open, x, "XOpenDisplay")
		purego.RegisterLibFunc(&root, x, "XDefaultRootWindow")
		purego.RegisterLibFunc(&alloc, s, "XScreenSaverAllocInfo")
		purego.RegisterLibFunc(&xss.query, s, "XScreenSaverQueryInfo")
		if xss.display = open(0); xss.display != 0 {
			xss.root, xss.info = root(xss.display), alloc()
		}
	})
	return xss.display != 0 && xss.info != 0
}

// idleOffset is where XScreenSaverInfo keeps the idle time in milliseconds: window, state, kind, til_or_since, idle.
const idleOffset = 24

var xMu sync.Mutex

func onWayland() bool { return os.Getenv("XDG_SESSION_TYPE") == "wayland" }

// Since is the time since the last key or mouse event; ok is false when this system cannot say.
func Since() (d time.Duration, ok bool) {
	if !onWayland() && openXScreenSaver() {
		xMu.Lock()
		defer xMu.Unlock()
		if xss.query(xss.display, xss.root, xss.info) != 0 {
			return time.Duration(*(*uint64)(unsafe.Add(unsafe.Pointer(nil), xss.info+idleOffset))) * time.Millisecond, true
		}
	}
	return logindIdle()
}

func logindIdle() (time.Duration, bool) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		return 0, false
	}
	defer conn.Close()
	session := conn.Object("org.freedesktop.login1", "/org/freedesktop/login1/session/auto")
	hint, err := session.GetProperty("org.freedesktop.login1.Session.IdleHint")
	if err != nil {
		return 0, false
	}
	if idle, _ := hint.Value().(bool); !idle {
		return 0, true
	}
	since, err := session.GetProperty("org.freedesktop.login1.Session.IdleSinceHint")
	if err != nil {
		return 0, false
	}
	micros, _ := since.Value().(uint64)
	return max(time.Since(time.UnixMicro(int64(micros))), 0), true
}
