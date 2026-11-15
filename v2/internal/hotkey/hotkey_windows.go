package hotkey

import (
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Two low-level hooks, one on the keyboard and one on the mouse, run on a thread of their own with a message loop.
// They only listen: the key still reaches the program in front, and nobody else loses it. A hook is the one way
// Windows reports a key coming up as well as going down, which push to talk needs.

const (
	whKeyboardLL = 13
	whMouseLL    = 14
	wmKeyDown    = 0x100
	wmKeyUp      = 0x101
	wmSysKeyDown = 0x104
	wmSysKeyUp   = 0x105
	wmMButtonDn  = 0x207
	wmMButtonUp  = 0x208
	wmXButtonDn  = 0x20B
	wmXButtonUp  = 0x20C
	wmQuit       = 0x12
	llkhfExtend  = 0x01
	llkhfInject  = 0x10
)

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	setHookEx       = user32.NewProc("SetWindowsHookExW")
	unhookEx        = user32.NewProc("UnhookWindowsHookEx")
	callNextHook    = user32.NewProc("CallNextHookEx")
	getMessage      = user32.NewProc("GetMessageW")
	postThreadMsg   = user32.NewProc("PostThreadMessageW")
	kernel32        = windows.NewLazySystemDLL("kernel32.dll")
	getCurrentTread = kernel32.NewProc("GetCurrentThreadId")
)

func supported() string { return ErrNone }

type winBackend struct {
	emit func(id string, down bool)

	mu      sync.Mutex
	matches []winMatch
	mods    modifierState
	running bool
	thread  uint32
	done    chan struct{}
}

type winMatch struct {
	id     string
	m      matcher
	button int
}

var winActive *winBackend

var (
	keyboardHook = syscall.NewCallback(func(code int32, wparam, lparam uintptr) uintptr {
		if b := winActive; b != nil && code >= 0 {
			b.key(wparam, (*kbdllhook)(unsafe.Add(unsafe.Pointer(nil), lparam)))
		}
		r, _, _ := callNextHook.Call(0, uintptr(code), wparam, lparam)
		return r
	})
	mouseHook = syscall.NewCallback(func(code int32, wparam, lparam uintptr) uintptr {
		if b := winActive; b != nil && code >= 0 {
			b.mouse(wparam, (*msllhook)(unsafe.Add(unsafe.Pointer(nil), lparam)))
		}
		r, _, _ := callNextHook.Call(0, uintptr(code), wparam, lparam)
		return r
	})
)

type kbdllhook struct {
	vk, scan, flags, time uint32
	extra                 uintptr
}

type msllhook struct {
	x, y  int32
	data  uint32
	flags uint32
	time  uint32
	extra uintptr
}

func newBackend(emit func(id string, down bool)) backend { return &winBackend{emit: emit} }

func (b *winBackend) set(entries []entry) []string {
	codes := make([]string, len(entries))
	var matches []winMatch
	for i, e := range entries {
		match := winMatch{id: e.id, m: matcher{combo: e.combo}}
		if n := e.combo.Mouse(); n > 0 {
			match.button = n
		} else if vk, ok := windowsKeyCodes[e.combo.Key]; ok {
			match.m.codes = vk
		} else {
			codes[i] = ErrInvalid
			continue
		}
		matches = append(matches, match)
	}
	b.mu.Lock()
	for _, old := range b.matches {
		if old.m.held {
			b.emit(old.id, false)
		}
	}
	b.matches = matches
	b.mu.Unlock()
	if len(matches) > 0 && !b.running {
		if !b.start() {
			for i := range codes {
				if codes[i] == ErrNone {
					codes[i] = ErrUnavailable
				}
			}
		}
	} else if len(matches) == 0 && b.running {
		b.stop()
	}
	return codes
}

func (b *winBackend) start() bool {
	winActive = b
	ready := make(chan bool)
	b.done = make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(b.done)
		id, _, _ := getCurrentTread.Call()
		kb, _, _ := setHookEx.Call(whKeyboardLL, keyboardHook, 0, 0)
		ms, _, _ := setHookEx.Call(whMouseLL, mouseHook, 0, 0)
		if kb == 0 {
			ready <- false
			return
		}
		b.thread = uint32(id)
		ready <- true
		var msg [8]uintptr
		for {
			r, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
			if int32(r) <= 0 {
				break
			}
		}
		unhookEx.Call(kb)
		if ms != 0 {
			unhookEx.Call(ms)
		}
	}()
	b.running = <-ready
	return b.running
}

func (b *winBackend) stop() {
	postThreadMsg.Call(uintptr(b.thread), wmQuit, 0, 0)
	<-b.done
	b.running = false
	b.mods = modifierState{}
}

func (b *winBackend) close() { b.set(nil) }

func (b *winBackend) setModifier(vk uint32, down bool) bool {
	switch vk {
	case 0xA2, 0xA3:
		b.mods.ctrl = down
	case 0xA4, 0xA5:
		b.mods.alt = down
	case 0xA0, 0xA1:
		b.mods.shift = down
	case 0x5B, 0x5C:
		b.mods.meta = down
	default:
		return false
	}
	return true
}

func (b *winBackend) key(wparam uintptr, k *kbdllhook) {
	down := wparam == wmKeyDown || wparam == wmSysKeyDown
	if !down && wparam != wmKeyUp && wparam != wmSysKeyUp {
		return
	}
	code := k.vk
	if code == 0x0D && k.flags&llkhfExtend != 0 {
		code = vkNumpadEnter
	}
	b.mu.Lock()
	b.setModifier(k.vk, down)
	var fire []func()
	for i := range b.matches {
		m := &b.matches[i]
		if m.button != 0 {
			continue
		}
		id := m.id
		if down && m.m.down(code, b.mods) {
			fire = append(fire, func() { b.emit(id, true) })
		} else if !down && m.m.up(code, b.mods) {
			fire = append(fire, func() { b.emit(id, false) })
		}
	}
	b.mu.Unlock()
	for _, f := range fire {
		f()
	}
}

func (b *winBackend) mouse(wparam uintptr, h *msllhook) {
	button, down := 0, false
	switch wparam {
	case wmMButtonDn, wmMButtonUp:
		button, down = 3, wparam == wmMButtonDn
	case wmXButtonDn, wmXButtonUp:
		button, down = 3+int(h.data>>16), wparam == wmXButtonDn
	default:
		return
	}
	b.mu.Lock()
	var fire []func()
	for i := range b.matches {
		m := &b.matches[i]
		if m.button != button {
			continue
		}
		id := m.id
		if down && !m.m.held && m.m.modsMatch(b.mods) {
			m.m.held = true
			fire = append(fire, func() { b.emit(id, true) })
		} else if !down && m.m.held {
			m.m.held = false
			fire = append(fire, func() { b.emit(id, false) })
		}
	}
	b.mu.Unlock()
	for _, f := range fire {
		f()
	}
}

const vkNumpadEnter = 0x10D

// windowsKeyCodes are the virtual-key codes a key answers to; a numpad key answers to its navigation twin as well, which is what it reports with Num Lock off.
var windowsKeyCodes = buildWindowsKeys()

func buildWindowsKeys() map[string][]uint32 {
	keys := map[string][]uint32{
		"Space": {0x20}, "Tab": {0x09}, "Enter": {0x0D, vkNumpadEnter}, "Backspace": {0x08}, "Delete": {0x2E}, "Insert": {0x2D},
		"Home": {0x24}, "End": {0x23}, "PageUp": {0x21}, "PageDown": {0x22}, "Up": {0x26}, "Down": {0x28}, "Left": {0x25}, "Right": {0x27},
		"Scrolllock": {0x91}, "PrintScreen": {0x2C}, "Capslock": {0x14}, "Numlock": {0x90},
		"-": {0xBD}, "=": {0xBB}, "[": {0xDB}, "]": {0xDD}, "\\": {0xDC}, ";": {0xBA}, "'": {0xDE}, ",": {0xBC}, ".": {0xBE}, "/": {0xBF}, "`": {0xC0},
		"numadd": {0x6B}, "numsub": {0x6D}, "nummult": {0x6A}, "numdiv": {0x6F}, "numdec": {0x6E, 0x2E}, "numenter": {vkNumpadEnter},
		"MediaPlayPause": {0xB3}, "MediaNextTrack": {0xB0}, "MediaPreviousTrack": {0xB1}, "MediaStop": {0xB2},
		"VolumeMute": {0xAD}, "VolumeUp": {0xAF}, "VolumeDown": {0xAE},
	}
	for c := 'A'; c <= 'Z'; c++ {
		keys[string(c)] = []uint32{uint32(c)}
	}
	for c := '0'; c <= '9'; c++ {
		keys[string(c)] = []uint32{uint32(c)}
	}
	for i := uint32(1); i <= 24; i++ {
		keys["F"+strconv.FormatUint(uint64(i), 10)] = []uint32{0x6F + i}
	}
	numNav := []uint32{0x2D, 0x23, 0x28, 0x22, 0x25, 0x0C, 0x27, 0x24, 0x26, 0x21}
	for i := uint32(0); i <= 9; i++ {
		keys["num"+strconv.FormatUint(uint64(i), 10)] = []uint32{0x60 + i, numNav[i]}
	}
	return keys
}
