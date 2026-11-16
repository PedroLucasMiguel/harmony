package tray

import (
	"strconv"
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

// The menu bar's status item and its menu, through the Objective-C runtime. Everything here runs on the thread the
// window runs on, which is the one thread AppKit allows.

const (
	statusLengthVariable = -1.0
	iconPoints           = 16.0
)

type size struct{ W, H float64 }

var (
	selAlloc     = objc.RegisterName("alloc")
	selInit      = objc.RegisterName("init")
	selString    = objc.RegisterName("stringWithUTF8String:")
	selData      = objc.RegisterName("dataWithBytes:length:")
	selStatusBar = objc.RegisterName("systemStatusBar")
	selStatusFor = objc.RegisterName("statusItemWithLength:")
	selRemove    = objc.RegisterName("removeStatusItem:")
	selButton    = objc.RegisterName("button")
	selSetImage  = objc.RegisterName("setImage:")
	selSetTip    = objc.RegisterName("setToolTip:")
	selSetTitle  = objc.RegisterName("setTitle:")
	selSetMenu   = objc.RegisterName("setMenu:")
	selSetSize   = objc.RegisterName("setSize:")
	selInitData  = objc.RegisterName("initWithData:")
	selInitTitle = objc.RegisterName("initWithTitle:")
	selAddItem   = objc.RegisterName("addItem:")
	selNewSep    = objc.RegisterName("separatorItem")
	selItemFor   = objc.RegisterName("initWithTitle:action:keyEquivalent:")
	selSetTarget = objc.RegisterName("setTarget:")
	selSetTag    = objc.RegisterName("setTag:")
	selSetState  = objc.RegisterName("setState:")
	selSetEnable = objc.RegisterName("setEnabled:")
	selAction    = objc.RegisterName("harmonyTrayAction:")
	selTag       = objc.RegisterName("tag")
	selRelease   = objc.RegisterName("release")
	selRemoveAll = objc.RegisterName("removeAllItems")
	selAutoEn    = objc.RegisterName("setAutoenablesItems:")
	selAppearOf  = objc.RegisterName("appearanceNamed:")
	selSetAppear = objc.RegisterName("setAppearance:")
	selResponds  = objc.RegisterName("respondsToSelector:")
)

type macTray struct {
	item    objc.ID
	button  objc.ID
	menu    objc.ID
	target  objc.ID
	actions []func()
	colours func() Colours
}

var macActive *macTray

func nsString(s string) objc.ID {
	return objc.ID(objc.GetClass("NSString")).Send(selString, s)
}

func start(opt Options) impl {
	class, err := objc.RegisterClass("HarmonyTrayTarget", objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{
		{Cmd: selAction, Fn: func(_ objc.ID, _ objc.SEL, sender objc.ID) {
			t := macActive
			if t == nil {
				return
			}
			if tag := int(objc.Send[int64](sender, selTag)); tag >= 0 && tag < len(t.actions) && t.actions[tag] != nil {
				t.actions[tag]()
			}
		}},
	})
	if err != nil {
		return nil
	}
	t := &macTray{colours: opt.Colours}
	t.target = objc.ID(class).Send(selAlloc).Send(selInit)
	bar := objc.ID(objc.GetClass("NSStatusBar")).Send(selStatusBar)
	t.item = bar.Send(selStatusFor, statusLengthVariable)
	if t.item == 0 {
		return nil
	}
	t.button = t.item.Send(selButton)
	macActive = t
	t.setIcon(opt.Icon)
	t.setTooltip(opt.Tooltip)
	if opt.Menu != nil {
		t.setMenu(opt.Menu())
	}
	return t
}

func (t *macTray) setIcon(png []byte) {
	if len(png) == 0 {
		return
	}
	data := objc.ID(objc.GetClass("NSData")).Send(selData, unsafe.Pointer(&png[0]), uint64(len(png)))
	image := objc.ID(objc.GetClass("NSImage")).Send(selAlloc).Send(selInitData, data)
	image.Send(selSetSize, size{iconPoints, iconPoints})
	t.button.Send(selSetImage, image)
	image.Send(selRelease)
}

func (t *macTray) setTooltip(text string) { t.button.Send(selSetTip, nsString(text)) }

func (t *macTray) setBadge(count int) {
	title := ""
	if count > 0 {
		title = " " + strconv.Itoa(count)
	}
	t.button.Send(selSetTitle, nsString(title))
}

func (t *macTray) setMenu(items []Item) {
	menu := objc.ID(objc.GetClass("NSMenu")).Send(selAlloc).Send(selInitTitle, nsString(""))
	menu.Send(selAutoEn, false)
	t.actions = t.actions[:0]
	for _, it := range items {
		if it.Separator {
			menu.Send(selAddItem, objc.ID(objc.GetClass("NSMenuItem")).Send(selNewSep))
			continue
		}
		mi := objc.ID(objc.GetClass("NSMenuItem")).Send(selAlloc).Send(selItemFor, nsString(it.Label), selAction, nsString(""))
		mi.Send(selSetTarget, t.target)
		mi.Send(selSetTag, int64(len(t.actions)))
		t.actions = append(t.actions, it.OnClick)
		if it.Checked {
			mi.Send(selSetState, int64(1))
		}
		mi.Send(selSetEnable, !it.Disabled)
		menu.Send(selAddItem, mi)
		mi.Send(selRelease)
	}
	t.appearance(menu)
	t.item.Send(selSetMenu, menu)
	if t.menu != 0 {
		t.menu.Send(selRelease)
	}
	t.menu = menu
}

// appearance makes the menu light or dark as the program's palette is, where the system lets a menu choose (macOS 11 on).
func (t *macTray) appearance(menu objc.ID) {
	if t.colours == nil || !objc.Send[bool](menu, selResponds, selSetAppear) {
		return
	}
	name := "NSAppearanceNameAqua"
	if t.colours().Dark() {
		name = "NSAppearanceNameDarkAqua"
	}
	menu.Send(selSetAppear, objc.ID(objc.GetClass("NSAppearance")).Send(selAppearOf, nsString(name)))
}

func (t *macTray) balloon(string, string, func()) {}

func (t *macTray) close() {
	objc.ID(objc.GetClass("NSStatusBar")).Send(selStatusBar).Send(selRemove, t.item)
	macActive = nil
}
