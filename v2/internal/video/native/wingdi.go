//go:build windows

// GDI, for what the capture of a window and the pictures of the share picker need: a bitmap the system draws a window or
// the screen into and that the program reads as memory.
package native

import (
	"errors"
	"syscall"
	"unsafe"
)

const (
	biRGB            = 0
	pwRenderFull     = 2 // PW_RENDERFULLCONTENT: windows drawn by the graphics card as well
	srcCopy          = 0x00CC0020
	captureBlt       = 0x40000000
	halftone         = 4
	cloakedAttribute = 14
)

var (
	dllGdi32  = syscall.NewLazyDLL("gdi32.dll")
	dllDwmapi = syscall.NewLazyDLL("dwmapi.dll")

	procCreateCompatibleDC    = dllGdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection      = dllGdi32.NewProc("CreateDIBSection")
	procSelectObject          = dllGdi32.NewProc("SelectObject")
	procDeleteObject          = dllGdi32.NewProc("DeleteObject")
	procDeleteDC              = dllGdi32.NewProc("DeleteDC")
	procStretchBlt            = dllGdi32.NewProc("StretchBlt")
	procSetStretchBltMode     = dllGdi32.NewProc("SetStretchBltMode")
	procGetObjectW            = dllGdi32.NewProc("GetObjectW")
	procGetDC                 = dllUser32.NewProc("GetDC")
	procReleaseDC             = dllUser32.NewProc("ReleaseDC")
	procPrintWindow           = dllUser32.NewProc("PrintWindow")
	procGetWindowRect         = dllUser32.NewProc("GetWindowRect")
	procIsWindow              = dllUser32.NewProc("IsWindow")
	procIsIconic              = dllUser32.NewProc("IsIconic")
	procGetWindow             = dllUser32.NewProc("GetWindow")
	procGetWindowLongW        = dllUser32.NewProc("GetWindowLongW")
	procDwmGetWindowAttribute = dllDwmapi.NewProc("DwmGetWindowAttribute")
)

// sys calls a DLL function and gives back its whole result, which is a handle or a count more often than a status.
//
//go:uintptrescapes
func sys(p *syscall.LazyProc, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(p.Addr(), args...)
	return r
}

type bitmapInfoHeader struct {
	size          uint32
	width, height int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPels, yPels  int32
	used, vital   uint32
}

type winRect struct{ left, top, right, bottom int32 }

func (r winRect) w() int { return int(r.right - r.left) }
func (r winRect) h() int { return int(r.bottom - r.top) }

// hwndOf is the window handle of a source ID's number: handles are 32 bits wide in what Windows hands between programs.
func hwndOf(n uint32) uintptr { return uintptr(int64(int32(n))) }

func windowRect(hwnd uintptr) (winRect, bool) {
	var r winRect
	if sys(procGetWindowRect, hwnd, uintptr(unsafe.Pointer(&r))) == 0 {
		return r, false
	}
	return r, true
}

// gdiSurface is a 32 bit bitmap, top row first, in memory the program can read, with a device context to draw into it.
type gdiSurface struct {
	dc, bmp, old, bits uintptr
	w, h               int
}

func newGDISurface(w, h int) (*gdiSurface, error) {
	if w <= 0 || h <= 0 {
		return nil, errors.New("nothing to capture")
	}
	s := &gdiSurface{w: w, h: h}
	if s.dc = sys(procCreateCompatibleDC, 0); s.dc == 0 {
		return nil, errors.New("CreateCompatibleDC failed")
	}
	hdr := bitmapInfoHeader{size: uint32(unsafe.Sizeof(bitmapInfoHeader{})), width: int32(w), height: -int32(h), planes: 1, bitCount: 32, compression: biRGB}
	s.bmp = sys(procCreateDIBSection, s.dc, uintptr(unsafe.Pointer(&hdr)), 0, uintptr(unsafe.Pointer(&s.bits)), 0, 0)
	if s.bmp == 0 || s.bits == 0 {
		s.close()
		return nil, errors.New("CreateDIBSection failed (too large a window?)")
	}
	s.old = sys(procSelectObject, s.dc, s.bmp)
	return s, nil
}

// pixels is the bitmap's memory: BGRA, w*4 bytes a row.
func (s *gdiSurface) pixels() []byte { return bytesAt(s.bits, s.w*s.h*4) }

func (s *gdiSurface) close() {
	if s.old != 0 {
		sys(procSelectObject, s.dc, s.old)
	}
	if s.bmp != 0 {
		sys(procDeleteObject, s.bmp)
	}
	if s.dc != 0 {
		sys(procDeleteDC, s.dc)
	}
	*s = gdiSurface{}
}

// printWindow has the window draw itself, whole, into the bitmap, whatever is over it; false when it will not.
func (s *gdiSurface) printWindow(hwnd uintptr) bool {
	return sys(procPrintWindow, hwnd, s.dc, pwRenderFull) != 0
}

// shrinkTo draws this bitmap smaller into dst, averaging, which is what a thumbnail is.
func (s *gdiSurface) shrinkTo(dst *gdiSurface) {
	sys(procSetStretchBltMode, dst.dc, halftone)
	sys(procStretchBlt, dst.dc, 0, 0, uintptr(dst.w), uintptr(dst.h), s.dc, 0, 0, uintptr(s.w), uintptr(s.h), srcCopy)
}
