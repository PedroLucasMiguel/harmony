//go:build windows

package native

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

const (
	gwlExStyle     = 0xFFFFFFEC // GWL_EXSTYLE, -20
	wsExToolWindow = 0x80
	wsExAppWindow  = 0x40000
	gwOwner        = 4
	minWindowEdge  = 64
	titleChars     = 512
)

// screenRects are the monitors DXGI has, the primary one first, in the order of "screen:<index>".
func screenRects() []winRect {
	factory := new(uintptr)
	if hr := callProc(procCreateDXGIFactory1, iidIDXGIFactory1.p(), uintptr(unsafe.Pointer(factory))); hr.failed() {
		return nil
	}
	f := com(*factory)
	defer f.release()
	var list []winRect
	for i := 0; ; i++ {
		var ad uintptr
		if hr := f.call(12, uintptr(i), uintptr(unsafe.Pointer(&ad))); hr.failed() {
			break
		}
		for j := 0; ; j++ {
			var out uintptr
			if hr := com(ad).call(7, uintptr(j), uintptr(unsafe.Pointer(&out))); hr.failed() {
				break
			}
			var desc dxgiOutputDesc
			if hr := com(out).call(7, uintptr(unsafe.Pointer(&desc))); !hr.failed() && desc.attached != 0 {
				r := winRect{desc.left, desc.top, desc.right, desc.bottom}
				if desc.left == 0 && desc.top == 0 {
					list = append([]winRect{r}, list...)
				} else {
					list = append(list, r)
				}
			}
			com(out).release()
		}
		com(ad).release()
	}
	return list
}

// listSources lists the monitors and the windows that can be shared, as "screen:<index>" (the index CaptureParams.Display takes) and
// "window:<handle>".
func listSources() []SourceInfo {
	var list []SourceInfo
	for i, r := range screenRects() {
		list = append(list, SourceInfo{ID: fmt.Sprintf("screen:%d", i), Kind: KindScreen, Name: fmt.Sprintf("Screen %d", i+1), W: r.w(), H: r.h()})
	}
	return append(list, listWindows()...)
}

// The callback of EnumWindows is made once: Go keeps every callback it makes for the life of the program.
var windows struct {
	once sync.Once
	mu   sync.Mutex
	cb   uintptr
	out  []SourceInfo
	self uint32
}

// listWindows is the windows a person would pick from: visible, not minimised, not a tool window or a ghost of a closed app,
// with a title and a size, and not this program's own.
func listWindows() []SourceInfo {
	windows.once.Do(func() {
		windows.self = uint32(os.Getpid())
		windows.cb = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
			if info, ok := shareableWindow(hwnd); ok {
				windows.out = append(windows.out, info)
			}
			return 1
		})
	})
	windows.mu.Lock()
	defer windows.mu.Unlock()
	windows.out = nil
	sys(procEnumWindows, windows.cb, 0)
	return append([]SourceInfo(nil), windows.out...)
}

func shareableWindow(hwnd uintptr) (SourceInfo, bool) {
	if sys(procIsWindowVisible, hwnd) == 0 || sys(procIsIconic, hwnd) != 0 || sys(procGetWindow, hwnd, gwOwner) != 0 {
		return SourceInfo{}, false
	}
	ex := sys(procGetWindowLongW, hwnd, gwlExStyle)
	if ex&wsExToolWindow != 0 && ex&wsExAppWindow == 0 {
		return SourceInfo{}, false
	}
	var cloaked uint32
	sys(procDwmGetWindowAttribute, hwnd, cloakedAttribute, uintptr(unsafe.Pointer(&cloaked)), unsafe.Sizeof(cloaked))
	if cloaked != 0 {
		return SourceInfo{}, false
	}
	r, ok := windowRect(hwnd)
	if !ok || r.w() < minWindowEdge || r.h() < minWindowEdge {
		return SourceInfo{}, false
	}
	var pid uint32
	sys(procGetWindowThreadProcessID, hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == windows.self {
		return SourceInfo{}, false
	}
	title := make([]uint16, titleChars)
	n := sys(procGetWindowTextW, hwnd, uintptr(unsafe.Pointer(&title[0])), titleChars)
	if n == 0 {
		return SourceInfo{}, false
	}
	name := syscall.UTF16ToString(title[:n])
	if name == "Program Manager" {
		return SourceInfo{}, false
	}
	return SourceInfo{ID: fmt.Sprintf("window:%d", uint32(hwnd)), Kind: KindWindow, Name: name, App: imageName(pid), W: r.w(), H: r.h()}, true
}

// sourceThumbnail is one small picture of a screen or a window, drawn by the system into a bitmap and shrunk.
func sourceThumbnail(id string, maxW int) ([]byte, int, int, bool) {
	kind, _ := ParseSourceID(id)
	var full *gdiSurface
	var err error
	switch kind {
	case KindScreen:
		n, ok := parseSourceNumber(id, KindScreen)
		rects := screenRects()
		if !ok || int(n) >= len(rects) {
			return nil, 0, 0, false
		}
		r := rects[n]
		if full, err = newGDISurface(r.w(), r.h()); err != nil {
			return nil, 0, 0, false
		}
		defer full.close()
		screen := sys(procGetDC, 0)
		defer sys(procReleaseDC, 0, screen)
		sys(procStretchBlt, full.dc, 0, 0, uintptr(r.w()), uintptr(r.h()), screen, uintptr(r.left), uintptr(r.top), uintptr(r.w()), uintptr(r.h()), srcCopy|captureBlt)
	case KindWindow:
		n, ok := parseSourceNumber(id, KindWindow)
		hwnd := hwndOf(n)
		r, there := windowRect(hwnd)
		if !ok || !there || sys(procIsIconic, hwnd) != 0 {
			return nil, 0, 0, false
		}
		if full, err = newGDISurface(r.w(), r.h()); err != nil {
			return nil, 0, 0, false
		}
		defer full.close()
		if !full.printWindow(hwnd) {
			return nil, 0, 0, false
		}
	default:
		return nil, 0, 0, false
	}
	w, h := min(maxW, full.w), full.h*min(maxW, full.w)/full.w
	small, err := newGDISurface(max(w, 1), max(h, 1))
	if err != nil {
		return nil, 0, 0, false
	}
	defer small.close()
	full.shrinkTo(small)
	src := small.pixels()
	rgba := make([]byte, len(src))
	for i := 0; i < len(src); i += 4 {
		rgba[i], rgba[i+1], rgba[i+2], rgba[i+3] = src[i+2], src[i+1], src[i], 255
	}
	return rgba, small.w, small.h, true
}

func screenAccess() bool { return true }

func openScreenSettings() {}
