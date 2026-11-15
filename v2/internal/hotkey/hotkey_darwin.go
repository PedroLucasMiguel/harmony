package hotkey

import (
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// Carbon's hot keys need no permission: the system delivers a pressed and a released event for each registered
// combination, to the application's event loop, whichever program is in front. Mouse buttons and media keys are not
// something it offers; they would need an event tap, which asks for the Accessibility permission.

const (
	carbonPath          = "/System/Library/Frameworks/Carbon.framework/Carbon"
	eventClassKeyboard  = 0x6B657962
	eventHotKeyPressed  = 5
	eventHotKeyReleased = 6
	eventParamDirect    = 0x2D2D2D2D
	typeHotKeyID        = 0x686B6964
	hotKeySignature     = 0x48524D59
	cmdKey              = 1 << 8
	shiftKey            = 1 << 9
	optionKey           = 1 << 11
	controlKey          = 1 << 12
	errHotKeyExists     = -9878
)

type eventTypeSpec struct{ class, kind uint32 }

var carbon struct {
	once              sync.Once
	ok                bool
	getTarget         func() uintptr
	installHandler    func(target, handler uintptr, count uint32, types *eventTypeSpec, data uintptr, out *uintptr) int32
	registerHotKey    func(code, mods uint32, id uint64, target uintptr, options uint32, out *uintptr) int32
	unregisterHotKey  func(ref uintptr) int32
	getEventKind      func(event uintptr) uint32
	getEventParameter func(event uintptr, name, kind uint32, actual *uint32, size uint32, got *uint32, data unsafe.Pointer) int32
	handler           uintptr
}

func loadCarbon() bool {
	carbon.once.Do(func() {
		lib, err := purego.Dlopen(carbonPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&carbon.getTarget, lib, "GetApplicationEventTarget")
		purego.RegisterLibFunc(&carbon.installHandler, lib, "InstallEventHandler")
		purego.RegisterLibFunc(&carbon.registerHotKey, lib, "RegisterEventHotKey")
		purego.RegisterLibFunc(&carbon.unregisterHotKey, lib, "UnregisterEventHotKey")
		purego.RegisterLibFunc(&carbon.getEventKind, lib, "GetEventKind")
		purego.RegisterLibFunc(&carbon.getEventParameter, lib, "GetEventParameter")
		carbon.ok = true
	})
	return carbon.ok
}

func supported() string {
	if loadCarbon() {
		return ErrNone
	}
	return ErrUnavailable
}

type macBackend struct {
	emit func(id string, down bool)

	mu    sync.Mutex
	refs  []uintptr
	ids   map[uint32]string
	next  uint32
	ready bool
	tap   macTap
}

var macActive *macBackend

func newBackend(emit func(id string, down bool)) backend {
	if !loadCarbon() {
		return nil
	}
	return &macBackend{emit: emit, ids: map[uint32]string{}}
}

func (b *macBackend) install() bool {
	if b.ready {
		return true
	}
	macActive = b
	carbon.handler = purego.NewCallback(func(_, event, _ uintptr) uintptr {
		active := macActive
		if active == nil {
			return 0
		}
		var id [2]uint32
		var got uint32
		if carbon.getEventParameter(event, eventParamDirect, typeHotKeyID, nil, 8, &got, unsafe.Pointer(&id)) != 0 {
			return 0
		}
		active.mu.Lock()
		name := active.ids[id[1]]
		active.mu.Unlock()
		if name != "" {
			active.emit(name, carbon.getEventKind(event) == eventHotKeyPressed)
		}
		return 0
	})
	types := [2]eventTypeSpec{{eventClassKeyboard, eventHotKeyPressed}, {eventClassKeyboard, eventHotKeyReleased}}
	var out uintptr
	b.ready = carbon.installHandler(carbon.getTarget(), carbon.handler, 2, &types[0], 0, &out) == 0
	return b.ready
}

func (b *macBackend) set(entries []entry) []string {
	var hot, heard []entry
	var hotAt, heardAt []int
	for i, e := range entries {
		if e.listen || e.combo.Mouse() > 0 {
			heard, heardAt = append(heard, e), append(heardAt, i)
		} else {
			hot, hotAt = append(hot, e), append(hotAt, i)
		}
	}
	codes := make([]string, len(entries))
	for j, code := range b.setHotKeys(hot) {
		codes[hotAt[j]] = code
	}
	for j, code := range b.tap.set(heard, b.emit) {
		codes[heardAt[j]] = code
	}
	return codes
}

func (b *macBackend) setHotKeys(entries []entry) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ref := range b.refs {
		carbon.unregisterHotKey(ref)
	}
	b.refs = b.refs[:0]
	clear(b.ids)
	codes := make([]string, len(entries))
	if !b.install() {
		for i := range codes {
			codes[i] = ErrUnavailable
		}
		return codes
	}
	for i, e := range entries {
		code, ok := macKeyCodes[e.combo.Key]
		if !ok {
			codes[i] = ErrInvalid
			continue
		}
		b.next++
		var ref uintptr
		id := uint64(hotKeySignature) | uint64(b.next)<<32
		status := carbon.registerHotKey(code, macModifiers(e.combo), id, carbon.getTarget(), 0, &ref)
		switch {
		case status == errHotKeyExists:
			codes[i] = ErrInUse
		case status != 0:
			codes[i] = ErrInvalid
		default:
			b.refs = append(b.refs, ref)
			b.ids[b.next] = e.id
		}
	}
	return codes
}

func (b *macBackend) close() { b.set(nil) }

func macModifiers(c Combo) uint32 {
	var m uint32
	if c.Meta {
		m |= cmdKey
	}
	if c.Shift {
		m |= shiftKey
	}
	if c.Alt {
		m |= optionKey
	}
	if c.Ctrl {
		m |= controlKey
	}
	return m
}

// macKeyCodes are the virtual key codes of the ANSI layout: the key's place on the keyboard, not the letter it types.
var macKeyCodes = map[string]uint32{
	"A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
	"Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
	"]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "Enter": 36, "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42,
	",": 43, "/": 44, "N": 45, "M": 46, ".": 47, "Tab": 48, "Space": 49, "`": 50, "Backspace": 51,
	"F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103,
	"F12": 111, "F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
	"Home": 115, "PageUp": 116, "Delete": 117, "End": 119, "PageDown": 121, "Left": 123, "Right": 124, "Down": 125, "Up": 126,
	"Insert": 114,
	"num0":   82, "num1": 83, "num2": 84, "num3": 85, "num4": 86, "num5": 87, "num6": 88, "num7": 89, "num8": 91, "num9": 92,
	"numdec": 65, "nummult": 67, "numadd": 69, "numdiv": 75, "numenter": 76, "numsub": 78, "Numlock": 71,
}
