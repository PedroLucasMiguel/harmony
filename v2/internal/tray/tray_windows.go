package tray

import (
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The notification area icon: a hidden window on a thread of its own owns it and runs the message loop. A right-click
// pops the menu up from here, built when it is asked for, because the shell's own pop-up does nothing while Harmony's
// window is the one in front.

const (
	wmUser        = 0x400
	wmTray        = wmUser + 1
	wmNull        = 0
	wmQuit        = 0x12
	wmLButtonUp   = 0x202
	wmRButtonUp   = 0x205
	nimAdd        = 0
	nimModify     = 1
	nimDelete     = 2
	nifMessage    = 1
	nifIcon       = 2
	nifTip        = 4
	nifInfo       = 0x10
	ninBalloonHit = wmUser + 5
	mfString      = 0
	mfGrayed      = 1
	mfChecked     = 8
	mfSeparator   = 0x800
	tpmReturnCmd  = 0x100
	tpmRightBtn   = 2
	hwndMessage   = ^uintptr(2) // -3
	iconSize      = 32
)

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	shell32         = windows.NewLazySystemDLL("shell32.dll")
	kernel32        = windows.NewLazySystemDLL("kernel32.dll")
	registerClass   = user32.NewProc("RegisterClassExW")
	createWindow    = user32.NewProc("CreateWindowExW")
	defWindowProc   = user32.NewProc("DefWindowProcW")
	getMessage      = user32.NewProc("GetMessageW")
	dispatchMessage = user32.NewProc("DispatchMessageW")
	postMessage     = user32.NewProc("PostMessageW")
	destroyWindow   = user32.NewProc("DestroyWindow")
	createIcon      = user32.NewProc("CreateIconFromResourceEx")
	destroyIcon     = user32.NewProc("DestroyIcon")
	createPopup     = user32.NewProc("CreatePopupMenu")
	appendMenu      = user32.NewProc("AppendMenuW")
	trackPopup      = user32.NewProc("TrackPopupMenu")
	destroyMenu     = user32.NewProc("DestroyMenu")
	setForeground   = user32.NewProc("SetForegroundWindow")
	getCursorPos    = user32.NewProc("GetCursorPos")
	registerMessage = user32.NewProc("RegisterWindowMessageW")
	notifyIcon      = shell32.NewProc("Shell_NotifyIconW")
	getModuleHandle = kernel32.NewProc("GetModuleHandleW")
)

type notifyIconData struct {
	size        uint32
	window      uintptr
	id          uint32
	flags       uint32
	callback    uint32
	icon        uintptr
	tip         [128]uint16
	state       uint32
	stateMask   uint32
	info        [256]uint16
	version     uint32
	infoTitle   [64]uint16
	infoFlags   uint32
	guid        [16]byte
	balloonIcon uintptr
}

type windowClass struct {
	size                               uint32
	style                              uint32
	proc                               uintptr
	classExtra, windowExtra            int32
	instance, icon, cursor, background uintptr
	menuName, className                *uint16
	iconSmall                          uintptr
}

type point struct{ x, y int32 }

type winTray struct {
	opt Options

	mu       sync.Mutex
	window   uintptr
	icon     uintptr
	data     notifyIconData
	created  uint32
	badge    int
	tip      string
	onBubble func()
	done     chan struct{}
}

var winActive *winTray

func start(opt Options) impl {
	t := &winTray{opt: opt, done: make(chan struct{}), tip: opt.Tooltip}
	ready := make(chan bool)
	go t.run(ready)
	if !<-ready {
		return nil
	}
	return t
}

func (t *winTray) run(ready chan bool) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(t.done)
	winActive = t
	instance, _, _ := getModuleHandle.Call(0)
	name, _ := windows.UTF16PtrFromString("HarmonyTray")
	class := windowClass{proc: syscall.NewCallback(trayProc), instance: instance, className: name}
	class.size = uint32(unsafe.Sizeof(class))
	registerClass.Call(uintptr(unsafe.Pointer(&class)))
	title, _ := windows.UTF16PtrFromString("Harmony")
	t.window, _, _ = createWindow.Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(title)), 0, 0, 0, 0, 0, hwndMessage, 0, instance, 0)
	if t.window == 0 {
		ready <- false
		return
	}
	restart, _, _ := registerMessage.Call(uintptr(unsafe.Pointer(mustUTF16("TaskbarCreated"))))
	t.created = uint32(restart)
	t.mu.Lock()
	t.data = notifyIconData{window: t.window, id: 1, flags: nifMessage | nifIcon | nifTip, callback: wmTray}
	t.data.size = uint32(unsafe.Sizeof(t.data))
	t.setIconLocked(t.opt.Icon)
	copy(t.data.tip[:], windows.StringToUTF16(t.tip))
	r, _, _ := notifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&t.data)))
	t.mu.Unlock()
	ready <- r != 0
	if r == 0 {
		return
	}
	var msg [8]uintptr
	for {
		got, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
		if int32(got) <= 0 {
			break
		}
		dispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
	}
}

func mustUTF16(s string) *uint16 {
	p, _ := windows.UTF16PtrFromString(s)
	return p
}

func trayProc(window, message, wparam, lparam uintptr) uintptr {
	t := winActive
	if t != nil {
		switch uint32(message) {
		case wmTray:
			switch uint32(lparam) {
			case wmLButtonUp:
				if t.opt.OnOpen != nil {
					go t.opt.OnOpen()
				}
			case wmRButtonUp:
				t.popup()
			case ninBalloonHit:
				t.mu.Lock()
				click := t.onBubble
				t.onBubble = nil
				t.mu.Unlock()
				if click != nil {
					go click()
				}
			}
			return 0
		case t.created:
			t.mu.Lock()
			notifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&t.data)))
			t.mu.Unlock()
			return 0
		}
	}
	r, _, _ := defWindowProc.Call(window, message, wparam, lparam)
	return r
}

func (t *winTray) popup() {
	if t.opt.Menu == nil {
		return
	}
	items := t.opt.Menu()
	menu, _, _ := createPopup.Call()
	defer destroyMenu.Call(menu)
	for i, it := range items {
		flags := uintptr(mfString)
		switch {
		case it.Separator:
			flags = mfSeparator
		case it.Disabled:
			flags |= mfGrayed
		}
		if it.Checked {
			flags |= mfChecked
		}
		appendMenu.Call(menu, flags, uintptr(i+1), uintptr(unsafe.Pointer(mustUTF16(it.Label))))
	}
	var at point
	getCursorPos.Call(uintptr(unsafe.Pointer(&at)))
	setForeground.Call(t.window)
	chosen, _, _ := trackPopup.Call(menu, tpmReturnCmd|tpmRightBtn, uintptr(at.x), uintptr(at.y), 0, t.window, 0)
	postMessage.Call(t.window, wmNull, 0, 0)
	if i := int(chosen) - 1; i >= 0 && i < len(items) && items[i].OnClick != nil {
		go items[i].OnClick()
	}
}

func (t *winTray) setIconLocked(png []byte) {
	if len(png) == 0 {
		return
	}
	icon, _, _ := createIcon.Call(uintptr(unsafe.Pointer(&png[0])), uintptr(len(png)), 1, 0x30000, iconSize, iconSize, 0)
	if icon == 0 {
		return
	}
	old := t.icon
	t.icon, t.data.icon = icon, icon
	if old != 0 {
		defer destroyIcon.Call(old)
	}
}

func (t *winTray) modify(flags uint32) {
	t.data.flags = nifMessage | flags
	notifyIcon.Call(nimModify, uintptr(unsafe.Pointer(&t.data)))
}

func (t *winTray) setIcon(png []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.setIconLocked(png)
	t.modify(nifIcon)
}

func (t *winTray) setTooltip(text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tip = text
	t.tooltipLocked()
}

func (t *winTray) tooltipLocked() {
	text := t.tip
	if t.badge > 0 {
		text += " (" + itoa(t.badge) + ")"
	}
	t.data.tip = [128]uint16{}
	copy(t.data.tip[:127], windows.StringToUTF16(text))
	t.modify(nifTip)
}

func (t *winTray) setBadge(count int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if count != t.badge {
		t.badge = count
		t.tooltipLocked()
	}
}

// setMenu has nothing to keep: the menu is built from Options.Menu when it is wanted.
func (t *winTray) setMenu([]Item) {}

func (t *winTray) balloon(title, body string, onClick func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.data.info = [256]uint16{}
	t.data.infoTitle = [64]uint16{}
	copy(t.data.info[:255], windows.StringToUTF16(body))
	copy(t.data.infoTitle[:63], windows.StringToUTF16(title))
	t.onBubble = onClick
	t.modify(nifInfo)
	t.data.info = [256]uint16{}
}

func (t *winTray) close() {
	t.mu.Lock()
	notifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&t.data)))
	t.mu.Unlock()
	postMessage.Call(t.window, wmQuit, 0, 0)
	<-t.done
	if t.icon != 0 {
		destroyIcon.Call(t.icon)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for ; n > 0; n /= 10 {
		i--
		b[i] = byte('0' + n%10)
	}
	return string(b[i:])
}
