//go:build linux

package native

// Screen capture on an X11 session: libX11 and libXext loaded at run time, the shared memory extension when the server has
// it (the server writes the picture straight into a segment we share) and XGetImage when it has not. Wayland has no such
// thing and goes through the portal instead.

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	x11ZPixmap    = 2
	x11AllPlanes  = ^uint64(0)
	x11IPCPrivate = 0
	x11IPCCreat   = 01000
	x11IPCRmid    = 0
)

type x11Funcs struct {
	openDisplay    func(name uintptr) uintptr
	closeDisplay   func(dpy uintptr) int32
	defaultScreen  func(dpy uintptr) int32
	rootWindow     func(dpy uintptr, screen int32) uintptr
	displayWidth   func(dpy uintptr, screen int32) int32
	displayHeight  func(dpy uintptr, screen int32) int32
	defaultVisual  func(dpy uintptr, screen int32) uintptr
	defaultDepth   func(dpy uintptr, screen int32) int32
	getImage       func(dpy, drawable uintptr, x, y int32, w, h uint32, mask uint64, format int32) uintptr
	destroyImage   func(img uintptr) int32
	sync           func(dpy uintptr, discard int32) int32
	setErrHandler  func(h uintptr) uintptr
	free           func(p uintptr) int32
	shmQuery       func(dpy uintptr) int32
	shmCreateImage func(dpy, visual uintptr, depth uint32, format int32, data uintptr, info uintptr, w, h uint32) uintptr
	shmAttach      func(dpy, info uintptr) int32
	shmDetach      func(dpy, info uintptr) int32
	shmGetImage    func(dpy, drawable, img uintptr, x, y int32, mask uint64) int32
	xineramaActive func(dpy uintptr) int32
	xineramaQuery  func(dpy uintptr, n *int32) uintptr
	hasShm         bool
	hasXinerama    bool
	errHandler     uintptr
}

var (
	x11Once sync.Once
	x11Lib  x11Funcs
	x11Err  error
)

const x11Install = "install libX11 (Debian/Ubuntu: libx11-6 and libxext6)"

func loadX11() (*x11Funcs, error) {
	x11Once.Do(func() {
		x, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			x11Err = fmt.Errorf("X11 is not available (%v): %s", err, x11Install)
			return
		}
		f := &x11Lib
		var missing string
		reg := func(fptr any, lib uintptr, name string) bool {
			if _, err := purego.Dlsym(lib, name); err != nil {
				return false
			}
			purego.RegisterLibFunc(fptr, lib, name)
			return true
		}
		must := func(fptr any, name string) {
			if !reg(fptr, x, name) {
				missing = name
			}
		}
		must(&f.openDisplay, "XOpenDisplay")
		must(&f.closeDisplay, "XCloseDisplay")
		must(&f.defaultScreen, "XDefaultScreen")
		must(&f.rootWindow, "XRootWindow")
		must(&f.displayWidth, "XDisplayWidth")
		must(&f.displayHeight, "XDisplayHeight")
		must(&f.defaultVisual, "XDefaultVisual")
		must(&f.defaultDepth, "XDefaultDepth")
		must(&f.getImage, "XGetImage")
		must(&f.destroyImage, "XDestroyImage")
		must(&f.sync, "XSync")
		must(&f.setErrHandler, "XSetErrorHandler")
		must(&f.free, "XFree")
		if missing != "" {
			x11Err = fmt.Errorf("libX11 is incomplete (no %s): %s", missing, x11Install)
			return
		}
		if ext, err := purego.Dlopen("libXext.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL); err == nil {
			f.hasShm = reg(&f.shmQuery, ext, "XShmQueryExtension") && reg(&f.shmCreateImage, ext, "XShmCreateImage") &&
				reg(&f.shmAttach, ext, "XShmAttach") && reg(&f.shmDetach, ext, "XShmDetach") && reg(&f.shmGetImage, ext, "XShmGetImage")
		}
		if xin, err := purego.Dlopen("libXinerama.so.1", purego.RTLD_NOW|purego.RTLD_GLOBAL); err == nil {
			f.hasXinerama = reg(&f.xineramaActive, xin, "XineramaIsActive") && reg(&f.xineramaQuery, xin, "XineramaQueryScreens")
		}
		// Xlib ends the program on any X error unless a handler takes it: a refused shared memory attach must not do that.
		f.errHandler = purego.NewCallback(func(dpy, ev uintptr) int32 { return 0 })
		f.setErrHandler(f.errHandler)
	})
	if x11Err != nil {
		return nil, x11Err
	}
	return &x11Lib, nil
}

// xShmSegmentInfo is XShmSegmentInfo: shmseg, shmid, shmaddr, readOnly.
type xShmSegmentInfo struct {
	Seg      uint64
	ID       int32
	_        int32
	Addr     uintptr
	ReadOnly int32
	_        int32
}

// xImage is the beginning of XImage: width, height, xoffset, format, data, byte_order, bitmap_unit, bitmap_bit_order,
// bitmap_pad, depth, bytes_per_line, bits_per_pixel, red_mask.
type xImage struct {
	Width, Height, XOffset, Format                                                int32
	Data                                                                          uintptr
	ByteOrder, BitmapUnit, BitOrder, BitmapPad, Depth, BytesPerLine, BitsPerPixel int32
	_                                                                             int32
	RedMask, GreenMask, BlueMask                                                  uint64
}

type x11Capture struct {
	fn         *x11Funcs
	dpy        uintptr
	root       uintptr
	x, y, w, h int
	shm        *xShmSegmentInfo
	img        uintptr
	sink       *captureSink
	scaler     *capScaler
	mode       string
	closing    chan struct{}
	finished   chan struct{}
	onEnd      func(error)
	once       sync.Once
}

func startX11(p CaptureParams, onAU func([]byte), onEnd func(error)) (Capture, error) {
	fn, err := loadX11()
	if err != nil {
		return nil, err
	}
	if os.Getenv("DISPLAY") == "" {
		return nil, errors.New("no graphical session: DISPLAY is not set")
	}
	dpy := fn.openDisplay(0)
	if dpy == 0 {
		return nil, fmt.Errorf("the X server %s cannot be opened", os.Getenv("DISPLAY"))
	}
	c := &x11Capture{fn: fn, dpy: dpy, closing: make(chan struct{}), finished: make(chan struct{}), onEnd: onEnd}
	screen := fn.defaultScreen(dpy)
	c.root = fn.rootWindow(dpy, screen)
	c.w, c.h = int(fn.displayWidth(dpy, screen)), int(fn.displayHeight(dpy, screen))
	c.pickMonitor(p.Display)
	if err := c.createImage(screen); err != nil {
		fn.closeDisplay(dpy)
		return nil, err
	}
	dw, dh := streamSize(c.w, c.h, p.Height)
	enc, err := newEncoder(EncodeParams{Width: dw, Height: dh, FPS: p.FPS, BitrateKbps: p.BitrateKbps, Matrix: p.Matrix, Backend: p.Backend}, onAU)
	if err != nil {
		c.release()
		return nil, err
	}
	c.mode = "x11+" + enc.Mode()
	c.sink = newCaptureSink(enc, dw, dh, p.FPS, p.Matrix, c.end)
	c.scaler = newCapScaler(c.w, c.h, dw, dh, 4)
	go c.run(time.Second / time.Duration(p.FPS))
	return c, nil
}

// pickMonitor limits the capture to one monitor when the server has Xinerama and more than one screen.
func (c *x11Capture) pickMonitor(index int) {
	if !c.fn.hasXinerama || c.fn.xineramaActive(c.dpy) == 0 {
		return
	}
	var n int32
	list := c.fn.xineramaQuery(c.dpy, &n)
	if list == 0 {
		return
	}
	defer c.fn.free(list)
	if n < 2 {
		return
	}
	// XineramaScreenInfo: screen_number int32, x_org, y_org, width, height int16.
	type info struct {
		Number              int32
		X, Y, Width, Height int16
	}
	infos := unsafe.Slice((*info)(addr(list)), n)
	m := infos[min(max(index, 0), int(n)-1)]
	c.x, c.y, c.w, c.h = int(m.X), int(m.Y), int(m.Width), int(m.Height)
}

func (c *x11Capture) createImage(screen int32) error {
	fn := c.fn
	if fn.hasShm && fn.shmQuery(c.dpy) != 0 {
		if c.createShmImage(screen) == nil {
			return nil
		}
	}
	return nil
}

func (c *x11Capture) createShmImage(screen int32) error {
	fn := c.fn
	info := &xShmSegmentInfo{}
	img := fn.shmCreateImage(c.dpy, fn.defaultVisual(c.dpy, screen), uint32(fn.defaultDepth(c.dpy, screen)), x11ZPixmap, 0, uintptr(unsafe.Pointer(info)), uint32(c.w), uint32(c.h))
	if img == 0 {
		return errors.New("no shared memory image")
	}
	im := (*xImage)(addr(img))
	size := uintptr(im.BytesPerLine) * uintptr(im.Height)
	id, _, errno := syscall.Syscall(syscall.SYS_SHMGET, x11IPCPrivate, size, x11IPCCreat|0600)
	if errno != 0 {
		fn.destroyImage(img)
		return errno
	}
	info.ID = int32(id)
	at, _, errno := syscall.Syscall(syscall.SYS_SHMAT, id, 0, 0)
	syscall.Syscall(syscall.SYS_SHMCTL, id, x11IPCRmid, 0)
	if errno != 0 {
		fn.destroyImage(img)
		return errno
	}
	info.Addr, im.Data = at, at
	if fn.shmAttach(c.dpy, uintptr(unsafe.Pointer(info))) == 0 {
		syscall.Syscall(syscall.SYS_SHMDT, at, 0, 0)
		im.Data = 0
		fn.destroyImage(img)
		return errors.New("the X server refused the shared memory segment")
	}
	fn.sync(c.dpy, 0)
	c.shm, c.img = info, img
	if _, _, err := c.grab(); err != nil {
		// A server that is not on this machine accepts the extension and then cannot reach the segment.
		c.releaseShm()
		c.shm, c.img = nil, 0
		return err
	}
	return nil
}

// grab takes one picture of the screen into the image and returns its pixels.
func (c *x11Capture) grab() (pix []byte, stride int, err error) {
	fn := c.fn
	img := c.img
	if c.shm != nil {
		if fn.shmGetImage(c.dpy, c.root, img, int32(c.x), int32(c.y), x11AllPlanes) == 0 {
			return nil, 0, errors.New("the X server did not give the screen")
		}
	} else {
		img = fn.getImage(c.dpy, c.root, int32(c.x), int32(c.y), uint32(c.w), uint32(c.h), x11AllPlanes, x11ZPixmap)
		if img == 0 {
			return nil, 0, errors.New("the X server did not give the screen")
		}
		defer fn.destroyImage(img)
	}
	im := (*xImage)(addr(img))
	if im.BitsPerPixel != 32 || im.RedMask != 0xff0000 || im.BlueMask != 0xff {
		return nil, 0, errors.New("the screen is not in a 32-bit colour mode this client reads")
	}
	stride = int(im.BytesPerLine)
	src := unsafe.Slice((*byte)(addr(im.Data)), stride*c.h)
	if c.shm != nil {
		return src, stride, nil
	}
	return append([]byte(nil), src...), stride, nil
}

func (c *x11Capture) run(interval time.Duration) {
	defer close(c.finished)
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-c.closing:
			return
		case <-tick.C:
		}
		dst := c.sink.begin(frameBGRA)
		if dst == nil {
			continue
		}
		pix, stride, err := c.grab()
		if err != nil {
			c.sink.abort()
			c.end(err)
			return
		}
		c.scaler.scale(dst, c.sink.w*4, pix, stride)
		c.sink.commit()
	}
}

func (c *x11Capture) end(err error) {
	c.once.Do(func() {
		select {
		case <-c.closing:
		default:
			go c.onEnd(err)
		}
	})
}

func (c *x11Capture) releaseShm() {
	fn := c.fn
	if c.shm != nil {
		fn.shmDetach(c.dpy, uintptr(unsafe.Pointer(c.shm)))
		fn.sync(c.dpy, 0)
		(*xImage)(addr(c.img)).Data = 0
		syscall.Syscall(syscall.SYS_SHMDT, c.shm.Addr, 0, 0)
		fn.destroyImage(c.img)
	}
}

func (c *x11Capture) release() {
	c.releaseShm()
	c.fn.closeDisplay(c.dpy)
}

func (c *x11Capture) Mode() string { return c.mode }

func (c *x11Capture) KeyFrame() { c.sink.keyFrame() }

func (c *x11Capture) Close() {
	select {
	case <-c.closing:
		return
	default:
	}
	close(c.closing)
	<-c.finished
	c.sink.close()
	c.release()
}
