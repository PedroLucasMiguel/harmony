package tray

import (
	"image/color"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The menu drawn in the program's colours. A menu of the system's own is always in the system's colours; with owner-drawn
// items the window that owns the menu is asked for each item's size and then to paint it, which is done here with GDI.

const (
	wmMeasureItem = 0x2C
	wmDrawItem    = 0x2B
	mfOwnerDraw   = 0x100
	mimBackground = 2
	odsSelected   = 1
	odsGrayed     = 2
	odsDisabled   = 4
	odsChecked    = 8
	transparent   = 1
	dtLeft        = 0
	dtVCenter     = 4
	dtSingleLine  = 0x20
	dtNoPrefix    = 0x800
	dtEndEllipsis = 0x8000
	spiGetMetrics = 0x29
	psSolid       = 0
	basePixels    = 96

	itemHeight     = 30
	ruleHeight     = 9
	gutter         = 34
	trailing       = 26
	leastWidth     = 170
	checkWidth     = 11
	checkDrop      = 6
	menuFontOffset = 1
)

var (
	gdi32             = windows.NewLazySystemDLL("gdi32.dll")
	setMenuInfo       = user32.NewProc("SetMenuInfo")
	getDC             = user32.NewProc("GetDC")
	releaseDC         = user32.NewProc("ReleaseDC")
	fillRect          = user32.NewProc("FillRect")
	drawText          = user32.NewProc("DrawTextW")
	getDpiForSystem   = user32.NewProc("GetDpiForSystem")
	systemInfoForDpi  = user32.NewProc("SystemParametersInfoForDpi")
	createSolidBrush  = gdi32.NewProc("CreateSolidBrush")
	createFontIndirct = gdi32.NewProc("CreateFontIndirectW")
	createPen         = gdi32.NewProc("CreatePen")
	deleteObject      = gdi32.NewProc("DeleteObject")
	selectObject      = gdi32.NewProc("SelectObject")
	setBkMode         = gdi32.NewProc("SetBkMode")
	setTextColor      = gdi32.NewProc("SetTextColor")
	getTextExtent     = gdi32.NewProc("GetTextExtentPoint32W")
	moveTo            = gdi32.NewProc("MoveToEx")
	lineTo            = gdi32.NewProc("LineTo")
)

type rect struct{ left, top, right, bottom int32 }

type measureItem struct {
	ctlType, ctlID, itemID, width, height uint32
	data                                  uintptr
}

type drawItem struct {
	ctlType, ctlID, itemID, action, state uint32
	item, dc                              uintptr
	area                                  rect
	data                                  uintptr
}

type menuInfo struct {
	size, mask, style, maxHeight uint32
	back                         uintptr
	help                         uint32
	data                         uintptr
}

type logFont struct {
	height, width, escapement, orientation, weight        int32
	italic, underline, strike, charset, outPrec, clipPrec byte
	quality, pitch                                        byte
	face                                                  [32]uint16
}

type nonClientMetrics struct {
	size                                 uint32
	border, scrollW, scrollH, capW, capH int32
	caption                              logFont
	smallCapW, smallCapH                 int32
	smallCaption                         logFont
	menuW, menuH                         int32
	menu, status, message                logFont
	padded                               int32
}

// menuPaint is what painting one showing of the menu needs; it lives while the menu is up.
type menuPaint struct {
	items       []Item
	colours     Colours
	back, light uintptr
	font        uintptr
	scale       float64
}

func rgb(c color.RGBA) uintptr { return uintptr(c.R) | uintptr(c.G)<<8 | uintptr(c.B)<<16 }

func newMenuPaint(items []Item, colours Colours) *menuPaint {
	p := &menuPaint{items: items, colours: colours, scale: 1}
	dpi := uint32(basePixels)
	if getDpiForSystem.Find() == nil {
		if d, _, _ := getDpiForSystem.Call(); d != 0 {
			dpi = uint32(d)
		}
	}
	p.scale = float64(dpi) / basePixels
	p.back, _, _ = createSolidBrush.Call(rgb(colours.Background))
	p.light, _, _ = createSolidBrush.Call(rgb(colours.Highlight))
	var ncm nonClientMetrics
	ncm.size = uint32(unsafe.Sizeof(ncm))
	if systemInfoForDpi.Find() == nil {
		if ok, _, _ := systemInfoForDpi.Call(spiGetMetrics, uintptr(ncm.size), uintptr(unsafe.Pointer(&ncm)), 0, uintptr(dpi)); ok != 0 {
			p.font, _, _ = createFontIndirct.Call(uintptr(unsafe.Pointer(&ncm.menu)))
		}
	}
	return p
}

func (p *menuPaint) release() {
	for _, h := range []uintptr{p.back, p.light, p.font} {
		if h != 0 {
			deleteObject.Call(h)
		}
	}
}

func (p *menuPaint) px(v int) int32 { return int32(float64(v)*p.scale + 0.5) }

// background paints the margin around the items in the menu's own colour.
func (p *menuPaint) background(menu uintptr) {
	info := menuInfo{mask: mimBackground, back: p.back}
	info.size = uint32(unsafe.Sizeof(info))
	setMenuInfo.Call(menu, uintptr(unsafe.Pointer(&info)))
}

func (p *menuPaint) item(data uintptr) *Item {
	if i := int(data) - 1; i >= 0 && i < len(p.items) {
		return &p.items[i]
	}
	return nil
}

func (p *menuPaint) measure(window uintptr, m *measureItem) {
	it := p.item(m.data)
	if it == nil {
		return
	}
	if it.Separator {
		m.width, m.height = uint32(p.px(leastWidth)), uint32(p.px(ruleHeight))
		return
	}
	width := p.px(leastWidth)
	dc, _, _ := getDC.Call(window)
	if dc != 0 {
		old, _, _ := selectObject.Call(dc, p.font)
		text := windows.StringToUTF16(it.Label)
		var size [2]int32
		getTextExtent.Call(dc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(&size)))
		selectObject.Call(dc, old)
		releaseDC.Call(window, dc)
		width = max(width, size[0]+p.px(gutter+trailing))
	}
	m.width, m.height = uint32(width), uint32(p.px(itemHeight))
}

func (p *menuPaint) draw(d *drawItem) {
	it := p.item(d.data)
	if it == nil {
		return
	}
	brush, ink := p.back, p.colours.Text
	lit := d.state&odsSelected != 0 && !it.Disabled && !it.Separator
	switch {
	case lit:
		brush, ink = p.light, p.colours.Accent
	case it.Disabled:
		ink = p.colours.Muted
	}
	fillRect.Call(d.dc, uintptr(unsafe.Pointer(&d.area)), brush)
	if it.Separator {
		pen, _, _ := createPen.Call(psSolid, 1, rgb(p.colours.Muted))
		old, _, _ := selectObject.Call(d.dc, pen)
		y := (d.area.top + d.area.bottom) / 2
		moveTo.Call(d.dc, uintptr(d.area.left+p.px(8)), uintptr(y), 0)
		lineTo.Call(d.dc, uintptr(d.area.right-p.px(8)), uintptr(y))
		selectObject.Call(d.dc, old)
		deleteObject.Call(pen)
		return
	}
	setBkMode.Call(d.dc, transparent)
	setTextColor.Call(d.dc, rgb(ink))
	old, _, _ := selectObject.Call(d.dc, p.font)
	text := windows.StringToUTF16(it.Label)
	area := rect{d.area.left + p.px(gutter), d.area.top, d.area.right - p.px(trailing/2), d.area.bottom}
	drawText.Call(d.dc, uintptr(unsafe.Pointer(&text[0])), ^uintptr(0), uintptr(unsafe.Pointer(&area)), dtLeft|dtVCenter|dtSingleLine|dtNoPrefix|dtEndEllipsis)
	selectObject.Call(d.dc, old)
	if it.Checked {
		p.tick(d, ink)
	}
}

// tick draws the check mark in the gutter.
func (p *menuPaint) tick(d *drawItem, ink color.RGBA) {
	pen, _, _ := createPen.Call(psSolid, uintptr(p.px(2)), rgb(ink))
	old, _, _ := selectObject.Call(d.dc, pen)
	x, y := d.area.left+p.px(12), (d.area.top+d.area.bottom)/2
	w := p.px(checkWidth)
	moveTo.Call(d.dc, uintptr(x), uintptr(y), 0)
	lineTo.Call(d.dc, uintptr(x+w*4/11), uintptr(y+p.px(checkDrop)/2+p.px(menuFontOffset)))
	lineTo.Call(d.dc, uintptr(x+w), uintptr(y-p.px(checkDrop)/2-p.px(menuFontOffset)))
	selectObject.Call(d.dc, old)
	deleteObject.Call(pen)
}
