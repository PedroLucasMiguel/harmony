//go:build linux

package hotkey

import (
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

const (
	keyPress      = 2
	keyRelease    = 3
	buttonPress   = 4
	buttonRelease = 5
	badAccess     = 10
	grabModeAsync = 1
	shiftMask     = 1 << 0
	lockMask      = 1 << 1
	controlMask   = 1 << 2
	mod1Mask      = 1 << 3
	mod2Mask      = 1 << 4
	mod4Mask      = 1 << 6
	buttonMasks   = 1<<2 | 1<<3
	xEventSize    = 192
)

var x11 struct {
	once       sync.Once
	ok         bool
	open       func(name uintptr) uintptr
	close      func(d uintptr) int32
	root       func(d uintptr) uintptr
	keycode    func(d uintptr, sym uint64) uint8
	grabKey    func(d uintptr, code int32, mods uint32, win uintptr, owner int32, pointer, keyboard int32) int32
	ungrabKey  func(d uintptr, code int32, mods uint32, win uintptr) int32
	grabButton func(d uintptr, button, mods uint32, win uintptr, owner int32, mask uint32, pointer, keyboard int32, confine, cursor uintptr) int32
	ungrabBtn  func(d uintptr, button, mods uint32, win uintptr) int32
	sync       func(d uintptr, discard int32) int32
	pending    func(d uintptr) int32
	next       func(d uintptr, ev unsafe.Pointer) int32
	peek       func(d uintptr, ev unsafe.Pointer) int32
	fd         func(d uintptr) int32
	errHandler func(handler uintptr) uintptr
	denied     bool
}

func loadX11() bool {
	x11.once.Do(func() {
		lib, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&x11.open, lib, "XOpenDisplay")
		purego.RegisterLibFunc(&x11.close, lib, "XCloseDisplay")
		purego.RegisterLibFunc(&x11.root, lib, "XDefaultRootWindow")
		purego.RegisterLibFunc(&x11.keycode, lib, "XKeysymToKeycode")
		purego.RegisterLibFunc(&x11.grabKey, lib, "XGrabKey")
		purego.RegisterLibFunc(&x11.ungrabKey, lib, "XUngrabKey")
		purego.RegisterLibFunc(&x11.grabButton, lib, "XGrabButton")
		purego.RegisterLibFunc(&x11.ungrabBtn, lib, "XUngrabButton")
		purego.RegisterLibFunc(&x11.sync, lib, "XSync")
		purego.RegisterLibFunc(&x11.pending, lib, "XPending")
		purego.RegisterLibFunc(&x11.next, lib, "XNextEvent")
		purego.RegisterLibFunc(&x11.peek, lib, "XPeekEvent")
		purego.RegisterLibFunc(&x11.fd, lib, "XConnectionNumber")
		purego.RegisterLibFunc(&x11.errHandler, lib, "XSetErrorHandler")
		x11.errHandler(purego.NewCallback(func(_, event uintptr) uintptr {
			// XErrorEvent: type, display, resourceid, serial, error_code at offset 32.
			if *(*uint8)(unsafe.Add(unsafe.Pointer(nil), event+32)) == badAccess {
				x11.denied = true
			}
			return 0
		}))
		x11.ok = true
	})
	return x11.ok
}

type grab struct {
	id     string
	code   int32
	button uint32
	mods   uint32
	held   bool
}

type x11Backend struct {
	emit func(id string, down bool)

	mu      sync.Mutex
	display uintptr
	root    uintptr
	grabs   []grab
	wake    [2]int
	running bool
	done    chan struct{}
}

// The grab must be made once for every state of Num Lock and Caps Lock, which X counts as modifiers.
var lockCombos = [4]uint32{0, lockMask, mod2Mask, lockMask | mod2Mask}

func (b *x11Backend) set(entries []entry) []string {
	codes := make([]string, len(entries))
	b.stop()
	if len(entries) == 0 {
		return codes
	}
	b.display = x11.open(0)
	if b.display == 0 {
		for i := range codes {
			codes[i] = ErrUnavailable
		}
		return codes
	}
	b.root = x11.root(b.display)
	for i, e := range entries {
		g := grab{id: e.id, mods: x11Modifiers(e.combo)}
		if n := e.combo.Mouse(); n > 0 {
			g.button = x11Button(n)
		} else if sym, ok := x11Keysyms[e.combo.Key]; ok {
			g.code = int32(x11.keycode(b.display, sym))
		}
		if g.button == 0 && g.code == 0 {
			codes[i] = ErrInvalid
			continue
		}
		x11.denied = false
		for _, lock := range lockCombos {
			if g.button != 0 {
				x11.grabButton(b.display, g.button, g.mods|lock, b.root, 0, buttonMasks, grabModeAsync, grabModeAsync, 0, 0)
			} else {
				x11.grabKey(b.display, g.code, g.mods|lock, b.root, 0, grabModeAsync, grabModeAsync)
			}
		}
		x11.sync(b.display, 0)
		if x11.denied {
			codes[i] = ErrInUse
			b.release(g)
			continue
		}
		b.grabs = append(b.grabs, g)
	}
	if len(b.grabs) == 0 {
		x11.close(b.display)
		b.display = 0
		return codes
	}
	b.start()
	return codes
}

func (b *x11Backend) release(g grab) {
	for _, lock := range lockCombos {
		if g.button != 0 {
			x11.ungrabBtn(b.display, g.button, g.mods|lock, b.root)
		} else {
			x11.ungrabKey(b.display, g.code, g.mods|lock, b.root)
		}
	}
}

func (b *x11Backend) start() {
	_ = unix.Pipe(b.wake[:])
	b.done = make(chan struct{})
	b.running = true
	go b.loop(b.display, b.wake[0], b.done)
}

func (b *x11Backend) stop() {
	if !b.running {
		return
	}
	_, _ = unix.Write(b.wake[1], []byte{1})
	<-b.done
	b.running = false
	for _, g := range b.grabs {
		b.release(g)
		if g.held {
			b.emit(g.id, false)
		}
	}
	b.grabs = nil
	x11.close(b.display)
	b.display = 0
	_ = unix.Close(b.wake[0])
	_ = unix.Close(b.wake[1])
}

func (b *x11Backend) close() { b.stop() }

// loop reads the grabbed keys until the pipe says stop. Holding a key makes the server send release and press pairs: a release followed at once by a press of the same key is the repeat, not a release.
func (b *x11Backend) loop(display uintptr, wake int, done chan struct{}) {
	defer close(done)
	fds := []unix.PollFd{{Fd: int32(x11.fd(display)), Events: unix.POLLIN}, {Fd: int32(wake), Events: unix.POLLIN}}
	var ev, ahead [xEventSize]byte
	for {
		for x11.pending(display) > 0 {
			x11.next(display, unsafe.Pointer(&ev[0]))
			kind := *(*int32)(unsafe.Pointer(&ev[0]))
			detail := *(*uint32)(unsafe.Pointer(&ev[84]))
			if kind == keyRelease && x11.pending(display) > 0 {
				x11.peek(display, unsafe.Pointer(&ahead[0]))
				if *(*int32)(unsafe.Pointer(&ahead[0])) == keyPress && *(*uint32)(unsafe.Pointer(&ahead[84])) == detail &&
					*(*uint64)(unsafe.Pointer(&ahead[56])) == *(*uint64)(unsafe.Pointer(&ev[56])) {
					continue
				}
			}
			switch kind {
			case keyPress, keyRelease:
				b.deliver(false, uint32(detail), kind == keyPress)
			case buttonPress, buttonRelease:
				b.deliver(true, detail, kind == buttonPress)
			}
		}
		if _, err := unix.Poll(fds, int(time.Hour/time.Millisecond)); err != nil && err != unix.EINTR {
			return
		}
		if fds[1].Revents != 0 {
			return
		}
	}
}

func (b *x11Backend) deliver(button bool, detail uint32, down bool) {
	b.mu.Lock()
	var ids []string
	for i := range b.grabs {
		g := &b.grabs[i]
		if (g.button != 0) != button || (button && g.button != detail) || (!button && uint32(g.code) != detail) || g.held == down {
			continue
		}
		g.held = down
		ids = append(ids, g.id)
	}
	b.mu.Unlock()
	for _, id := range ids {
		b.emit(id, down)
	}
}

func x11Modifiers(c Combo) uint32 {
	var m uint32
	if c.Shift {
		m |= shiftMask
	}
	if c.Ctrl {
		m |= controlMask
	}
	if c.Alt {
		m |= mod1Mask
	}
	if c.Meta {
		m |= mod4Mask
	}
	return m
}

// x11Button is the X button number of a button as the dialog numbers them: 3 is the middle button (2 in X), and the thumb buttons are 8 and 9.
func x11Button(n int) uint32 {
	switch n {
	case 3:
		return 2
	case 4:
		return 8
	case 5:
		return 9
	}
	return uint32(n + 4)
}

var x11Keysyms = buildKeysyms()

func buildKeysyms() map[string]uint64 {
	keys := map[string]uint64{
		"Space": 0x20, "Tab": 0xff09, "Enter": 0xff0d, "Backspace": 0xff08, "Delete": 0xffff, "Insert": 0xff63,
		"Home": 0xff50, "End": 0xff57, "PageUp": 0xff55, "PageDown": 0xff56, "Up": 0xff52, "Down": 0xff54, "Left": 0xff51, "Right": 0xff53,
		"Scrolllock": 0xff14, "PrintScreen": 0xff61, "Capslock": 0xffe5, "Numlock": 0xff7f,
		"-": '-', "=": '=', "[": '[', "]": ']', "\\": '\\', ";": ';', "'": '\'', ",": ',', ".": '.', "/": '/', "`": '`',
		"numadd": 0xffab, "numsub": 0xffad, "nummult": 0xffaa, "numdiv": 0xffaf, "numdec": 0xffae, "numenter": 0xff8d,
		"MediaPlayPause": 0x1008ff14, "MediaNextTrack": 0x1008ff17, "MediaPreviousTrack": 0x1008ff16, "MediaStop": 0x1008ff15,
		"VolumeMute": 0x1008ff12, "VolumeUp": 0x1008ff13, "VolumeDown": 0x1008ff11,
	}
	for c := 'A'; c <= 'Z'; c++ {
		keys[string(c)] = uint64(c - 'A' + 'a')
	}
	for c := '0'; c <= '9'; c++ {
		keys[string(c)] = uint64(c)
		keys["num"+string(c)] = 0xffb0 + uint64(c-'0')
	}
	for i := uint64(1); i <= 24; i++ {
		keys["F"+strconv.FormatUint(i, 10)] = 0xffbd + i
	}
	return keys
}
