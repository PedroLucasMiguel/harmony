package hotkey

import (
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// A listen-only event tap hears every key and mouse button without taking any: push to talk with a bare key, and the extra mouse buttons, which Carbon's hot keys cannot do. The system asks the person for
// the Input Monitoring permission the first time, and delivers nothing until it is given.

const (
	tapSessionLocation = 1
	tapHeadInsert      = 0
	tapListenOnly      = 1
	evKeyDown          = 10
	evKeyUp            = 11
	evFlagsChanged     = 12
	evOtherMouseDown   = 25
	evOtherMouseUp     = 26
	evTapTimedOut      = 0xFFFFFFFE
	fieldKeycode       = 9
	fieldButton        = 3
	flagShift          = 0x20000
	flagControl        = 0x40000
	flagOption         = 0x80000
	flagCommand        = 0x100000
)

var coregraphics struct {
	once       sync.Once
	ok         bool
	tapCreate  func(tap, place, options uint32, mask uint64, callback, info uintptr) uintptr
	tapEnable  func(tap uintptr, enable bool)
	source     func(allocator, port uintptr, order int64) uintptr
	mainLoop   func() uintptr
	addSource  func(loop, source, mode uintptr)
	removeSrc  func(loop, source, mode uintptr)
	field      func(event uintptr, field uint32) int64
	flags      func(event uintptr) uint64
	requestAcc func() bool
	release    func(ref uintptr)
	mode       uintptr
	callback   uintptr
}

func loadCoreGraphics() bool {
	coregraphics.once.Do(func() {
		cg, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&coregraphics.tapCreate, cg, "CGEventTapCreate")
		purego.RegisterLibFunc(&coregraphics.tapEnable, cg, "CGEventTapEnable")
		purego.RegisterLibFunc(&coregraphics.field, cg, "CGEventGetIntegerValueField")
		purego.RegisterLibFunc(&coregraphics.flags, cg, "CGEventGetFlags")
		purego.RegisterLibFunc(&coregraphics.requestAcc, cg, "CGRequestListenEventAccess")
		purego.RegisterLibFunc(&coregraphics.source, cf, "CFMachPortCreateRunLoopSource")
		purego.RegisterLibFunc(&coregraphics.mainLoop, cf, "CFRunLoopGetMain")
		purego.RegisterLibFunc(&coregraphics.addSource, cf, "CFRunLoopAddSource")
		purego.RegisterLibFunc(&coregraphics.removeSrc, cf, "CFRunLoopRemoveSource")
		purego.RegisterLibFunc(&coregraphics.release, cf, "CFRelease")
		mode, err := purego.Dlsym(cf, "kCFRunLoopCommonModes")
		if err != nil {
			return
		}
		coregraphics.mode = *(*uintptr)(unsafe.Add(unsafe.Pointer(nil), mode))
		coregraphics.ok = true
	})
	return coregraphics.ok
}

type macTap struct {
	mu      sync.Mutex
	port    uintptr
	source  uintptr
	matches []tapMatch
	emit    func(id string, down bool)
}

type tapMatch struct {
	id     string
	m      matcher
	button int
}

var tapActive *macTap

func (t *macTap) set(entries []entry, emit func(id string, down bool)) []string {
	codes := make([]string, len(entries))
	t.mu.Lock()
	for _, old := range t.matches {
		if old.m.held {
			emit(old.id, false)
		}
	}
	t.matches, t.emit = t.matches[:0], emit
	for i, e := range entries {
		match := tapMatch{id: e.id, m: matcher{combo: e.combo}}
		if n := e.combo.Mouse(); n > 0 {
			match.button = n
		} else if code, ok := macKeyCodes[e.combo.Key]; ok {
			match.m.codes = []uint32{code}
		} else {
			codes[i] = ErrInvalid
			continue
		}
		t.matches = append(t.matches, match)
	}
	want := len(t.matches) > 0
	t.mu.Unlock()
	switch {
	case want && t.port == 0:
		if !t.start() {
			for i := range codes {
				if codes[i] == ErrNone {
					codes[i] = ErrPermission
				}
			}
		}
	case !want && t.port != 0:
		t.stop()
	}
	return codes
}

func (t *macTap) start() bool {
	if !loadCoreGraphics() {
		return false
	}
	tapActive = t
	if coregraphics.callback == 0 {
		coregraphics.callback = purego.NewCallback(func(_, kind, event, _ uintptr) uintptr {
			if active := tapActive; active != nil {
				active.heard(uint32(kind), event)
			}
			return event
		})
	}
	mask := uint64(1<<evKeyDown | 1<<evKeyUp | 1<<evFlagsChanged | 1<<evOtherMouseDown | 1<<evOtherMouseUp)
	t.port = coregraphics.tapCreate(tapSessionLocation, tapHeadInsert, tapListenOnly, mask, coregraphics.callback, 0)
	if t.port == 0 {
		coregraphics.requestAcc()
		return false
	}
	t.source = coregraphics.source(0, t.port, 0)
	coregraphics.addSource(coregraphics.mainLoop(), t.source, coregraphics.mode)
	coregraphics.tapEnable(t.port, true)
	return true
}

func (t *macTap) stop() {
	coregraphics.tapEnable(t.port, false)
	coregraphics.removeSrc(coregraphics.mainLoop(), t.source, coregraphics.mode)
	coregraphics.release(t.source)
	coregraphics.release(t.port)
	t.port, t.source = 0, 0
	tapActive = nil
}

func (t *macTap) heard(kind uint32, event uintptr) {
	if kind == evTapTimedOut {
		coregraphics.tapEnable(t.port, true)
		return
	}
	flags := coregraphics.flags(event)
	mods := modifierState{ctrl: flags&flagControl != 0, alt: flags&flagOption != 0, shift: flags&flagShift != 0, meta: flags&flagCommand != 0}
	t.mu.Lock()
	var fire []func()
	for i := range t.matches {
		m := &t.matches[i]
		id := m.id
		switch kind {
		case evKeyDown, evKeyUp, evFlagsChanged:
			if m.button != 0 {
				continue
			}
			code := uint32(coregraphics.field(event, fieldKeycode))
			if kind == evKeyDown && m.m.down(code, mods) {
				fire = append(fire, func() { t.emit(id, true) })
			} else if kind != evKeyDown && m.m.up(code, mods) {
				fire = append(fire, func() { t.emit(id, false) })
			}
		case evOtherMouseDown, evOtherMouseUp:
			if m.button == 0 || int(coregraphics.field(event, fieldButton))+1 != m.button {
				continue
			}
			if kind == evOtherMouseDown && !m.m.held && m.m.modsMatch(mods) {
				m.m.held = true
				fire = append(fire, func() { t.emit(id, true) })
			} else if kind == evOtherMouseUp && m.m.held {
				m.m.held = false
				fire = append(fire, func() { t.emit(id, false) })
			}
		}
	}
	t.mu.Unlock()
	for _, f := range fire {
		f()
	}
}
