package shell

import (
	"os"
	"runtime"
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/platform"
	"harmony/v2/internal/screens/about"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

// frameKind is who draws the window's frame.
type frameKind int

const (
	// frameNative keeps the system's frame and draws the bar as the first row of the content.
	frameNative frameKind = iota
	// frameMac keeps the system's three buttons over a clear title bar the program draws beside.
	frameMac
	// frameApp has no frame at all: the program draws the buttons and moves and resizes the window itself.
	frameApp
)

const (
	macLeft      = 82
	lightsX      = 14
	lightsTop    = 10
	resizeEdge   = 6
	resizeCorner = 12
	outlineAlpha = 0.28
)

var frame = pickFrame()

// pickFrame is the frameless window where it can be done without the system's help. HARMONY_NATIVE_FRAME=1 keeps the system's frame everywhere; HARMONY_APP_FRAME=1 draws the buttons on every system, to try them.
func pickFrame() frameKind {
	switch {
	case os.Getenv("HARMONY_NATIVE_FRAME") == "1":
		return frameNative
	case os.Getenv("HARMONY_APP_FRAME") == "1":
		return frameApp
	case runtime.GOOS == "darwin":
		return frameMac
	case runtime.GOOS == "windows":
		return frameApp
	case os.Getenv("XDG_SESSION_TYPE") == "wayland" && os.Getenv("DISPLAY") == "":
		return frameNative
	}
	return frameApp
}

// chrome is the title bar and what the window needs from the program once it has no frame of its own.
type chrome struct {
	bar        widget.TitleBar
	made       bool
	drag       dragState
	resize     resizeState
	hover      edge
	fullscreen bool
	lastW      int
	lastH      int

	// where the program keeps the window maximised itself (Windows without a frame), and the place to go back to
	maximized bool
	restore   screenRect
}

// screenRect is a window's place and size on the screen, in pixels.
type screenRect struct{ x, y, w, h int }

type dragState struct {
	on     bool
	ox, oy float32
	// absolute: the pointer and the window where the drag began, in screen pixels, for a system that can say where the
	// pointer is; the pointer position inside a window that moves under it lags the window
	absolute bool
	px, py   int
	start    screenRect
}

type resizeState struct {
	on         bool
	edge       edge
	mx, my     float32
	x, y, w, h int

	absolute bool
	px, py   int
	start    screenRect
	unit     float32
}

type edge uint8

const (
	edgeLeft edge = 1 << iota
	edgeRight
	edgeTop
	edgeBottom
)

// applyFrame sets the window up for its frame; the window must exist.
func applyFrame(handle unsafe.Pointer) {
	if frame == frameMac {
		platform.CustomFrame(handle)
		platform.PlaceTrafficLights(handle, lightsX, lightsTop)
	}
}

func openFlags() uint32 {
	if frame == frameApp {
		return rl.FlagWindowUndecorated
	}
	return 0
}

func (sh *Shell) barTitle() (string, bool) {
	if sh.channels != nil && sh.open != "" {
		return sh.channels.ServerTitle(), true
	}
	return title, false
}

func (sh *Shell) buildBar() {
	ch := &sh.chrome
	ch.made = true
	ch.bar = widget.TitleBar{
		OnAbout:       func() { sh.context.OpenModal(about.New()) },
		Controls:      frame == frameApp,
		OnDrag:        sh.startDrag,
		OnMinimize:    rl.MinimizeWindow,
		OnMaximize:    sh.toggleMaximize,
		OnClose:       func() { sh.quit.Store(true) },
		OnDoubleClick: sh.toggleMaximize,
	}
}

func (sh *Shell) navigate(forward bool) {
	if sh.channels == nil {
		return
	}
	if forward {
		sh.channels.GoForward()
	} else {
		sh.channels.GoBack()
	}
}

// closeWindow is the close button: it hides into the tray where there is one, as the window's own would.
func (sh *Shell) closeWindow() {
	if sh.desktop.HideOnClose() {
		sh.desktop.HideWindow()
		return
	}
	sh.quit.Store(true)
}

func (sh *Shell) startDrag() {
	d := dragState{on: true, ox: sh.in.MouseX, oy: sh.in.MouseY}
	if px, py, ok := platform.CursorPosition(); ok {
		if x, y, w, h, ok := platform.WindowRect(sh.window); ok {
			if sh.chrome.maximized {
				// dragging a maximised window takes it out of that, with the pointer at the same place along the bar
				back := sh.chrome.restore
				share := float64(px-x) / float64(max(w, 1))
				x, w, h = px-int(share*float64(back.w)), back.w, back.h
				sh.restoreWindow(screenRect{x, y, w, h})
			}
			d.absolute, d.px, d.py, d.start = true, px, py, screenRect{x, y, w, h}
		}
	}
	sh.chrome.drag = d
}

// ownMaximize says whether the program maximises the window itself. A window without a frame that the window system
// maximises covers the taskbar too, so on Windows the program takes the monitor's work area, which the taskbar leaves free.
func ownMaximize() bool { return frame == frameApp && runtime.GOOS == "windows" }

func (sh *Shell) isMaximized() bool {
	if ownMaximize() {
		return sh.chrome.maximized
	}
	return rl.IsWindowMaximized()
}

func (sh *Shell) toggleMaximize() {
	ch := &sh.chrome
	ch.drag.on = false
	if frame == frameMac {
		platform.ToggleZoom(sh.window)
		return
	}
	if !ownMaximize() {
		if rl.IsWindowMaximized() {
			rl.RestoreWindow()
		} else {
			rl.MaximizeWindow()
		}
		return
	}
	if ch.maximized {
		sh.restoreWindow(ch.restore)
		return
	}
	x, y, w, h, ok := platform.WindowRect(sh.window)
	wx, wy, ww, wh, free := platform.WorkArea(sh.window)
	if !ok || !free {
		rl.MaximizeWindow()
		return
	}
	ch.restore, ch.maximized = screenRect{x, y, w, h}, true
	platform.SetWindowRect(sh.window, wx, wy, ww, wh)
}

func (sh *Shell) restoreWindow(r screenRect) {
	sh.chrome.maximized = false
	platform.SetWindowRect(sh.window, r.x, r.y, r.w, r.h)
}

// drawBar draws the title bar across the top of bounds.
func (sh *Shell) drawBar(c *widget.Context, bounds geom.Rect) {
	ch := &sh.chrome
	if !ch.made {
		sh.buildBar()
		ch.bar.OnClose = sh.closeWindow
	}
	if ch.hover != 0 {
		c.SetCursor(cursorFor(ch.hover))
	}
	b := &ch.bar
	b.Title, b.Badged = sh.barTitle()
	b.Left = 0
	if frame == frameMac && !ch.fullscreen {
		b.Left = macLeft
	}
	b.Maximized = frame == frameApp && sh.isMaximized()
	b.Draw(c, geom.Rect{X: bounds.X, Y: bounds.Y, W: bounds.W, H: widget.TitleBarHeight})
}

// chromeInput moves the window while the bar is dragged and keeps the system's buttons where the bar expects them. It runs once per input poll.
func (sh *Shell) chromeInput() {
	ch := &sh.chrome
	if ch.drag.on {
		d := &ch.drag
		switch px, py, ok := platform.CursorPosition(); {
		case !sh.in.Down:
			d.on = false
		case d.absolute && ok:
			platform.SetWindowRect(sh.window, d.start.x+px-d.px, d.start.y+py-d.py, d.start.w, d.start.h)
		case !d.absolute:
			if dx, dy := sh.in.MouseX-d.ox, sh.in.MouseY-d.oy; dx != 0 || dy != 0 {
				pos := rl.GetWindowPosition()
				rl.SetWindowPosition(int(pos.X+dx), int(pos.Y+dy))
			}
		}
	}
	if frame == frameApp {
		sh.resizeWindow()
	}
}

// syncFrame puts the traffic lights back where the system's own layout moved them, after the window changed size or went full screen.
func (sh *Shell) syncFrame() {
	if frame != frameMac {
		return
	}
	ch := &sh.chrome
	full := platform.IsFullScreen(sh.window)
	if full != ch.fullscreen || sh.width != ch.lastW || sh.height != ch.lastH {
		ch.fullscreen, ch.lastW, ch.lastH = full, sh.width, sh.height
		if !full {
			platform.PlaceTrafficLights(sh.window, lightsX, lightsTop)
		}
	}
}

func (sh *Shell) edgeAt(x, y float32) edge {
	if sh.isMaximized() || rl.IsWindowFullscreen() {
		return 0
	}
	w, h := float32(sh.width), float32(sh.height)
	var e edge
	if x < resizeEdge {
		e |= edgeLeft
	} else if x >= w-resizeEdge {
		e |= edgeRight
	}
	if y < resizeEdge {
		e |= edgeTop
	} else if y >= h-resizeEdge {
		e |= edgeBottom
	}
	if e == 0 {
		return 0
	}
	if (e == edgeLeft || e == edgeRight) && (y < resizeCorner || y >= h-resizeCorner) {
		if y < resizeCorner {
			e |= edgeTop
		} else {
			e |= edgeBottom
		}
	}
	if (e == edgeTop || e == edgeBottom) && (x < resizeCorner || x >= w-resizeCorner) {
		if x < resizeCorner {
			e |= edgeLeft
		} else {
			e |= edgeRight
		}
	}
	return e
}

func cursorFor(e edge) int32 {
	switch e {
	case edgeLeft, edgeRight:
		return rl.MouseCursorResizeEW
	case edgeTop, edgeBottom:
		return rl.MouseCursorResizeNS
	case edgeLeft | edgeTop, edgeRight | edgeBottom:
		return rl.MouseCursorResizeNWSE
	}
	return rl.MouseCursorResizeNESW
}

// resizeWindow lets the window be sized by its edges, which a window without a frame has no system way to do.
func (sh *Shell) resizeWindow() {
	r := &sh.chrome.resize
	if r.on && r.absolute {
		if px, py, ok := platform.CursorPosition(); ok && sh.in.Down {
			sh.resizeAbsolute(r, px, py)
			return
		}
		r.on = false
		return
	}
	if r.on {
		if !sh.in.Down {
			r.on = false
			return
		}
		pos := rl.GetWindowPosition()
		dx, dy := int(sh.in.MouseX+pos.X-r.mx), int(sh.in.MouseY+pos.Y-r.my)
		x, y, w, h := r.x, r.y, r.w, r.h
		if r.edge&edgeLeft != 0 {
			x, w = r.x+dx, r.w-dx
		}
		if r.edge&edgeRight != 0 {
			w = r.w + dx
		}
		if r.edge&edgeTop != 0 {
			y, h = r.y+dy, r.h-dy
		}
		if r.edge&edgeBottom != 0 {
			h = r.h + dy
		}
		least := sh.context.Paint.Zoom
		lw, lh := sh.leastSize()
		minW, minH := int(lw*least), int(lh*least)
		if w < minW {
			if r.edge&edgeLeft != 0 {
				x -= minW - w
			}
			w = minW
		}
		if h < minH {
			if r.edge&edgeTop != 0 {
				y -= minH - h
			}
			h = minH
		}
		rl.SetWindowPosition(x, y)
		rl.SetWindowSize(w, h)
		return
	}
	e := sh.edgeAt(sh.in.MouseX, sh.in.MouseY)
	sh.chrome.hover = e
	if e == 0 {
		return
	}
	if !sh.in.Pressed {
		return
	}
	if px, py, ok := platform.CursorPosition(); ok {
		if x, y, w, h, ok := platform.WindowRect(sh.window); ok {
			*r = resizeState{on: true, edge: e, absolute: true, px: px, py: py, start: screenRect{x, y, w, h}, unit: float32(w) / float32(max(sh.width, 1))}
			return
		}
	}
	pos := rl.GetWindowPosition()
	*r = resizeState{on: true, edge: e, mx: sh.in.MouseX + pos.X, my: sh.in.MouseY + pos.Y, x: int(pos.X), y: int(pos.Y), w: sh.width, h: sh.height}
}

// resizeAbsolute sizes the window from where the pointer is on the screen, and sets its place and size in one step: a window
// moved and then sized shows the frame between the two, which on the top and left edges is a flicker with every step.
func (sh *Shell) resizeAbsolute(r *resizeState, px, py int) {
	dx, dy := px-r.px, py-r.py
	x, y, w, h := r.start.x, r.start.y, r.start.w, r.start.h
	if r.edge&edgeLeft != 0 {
		x, w = x+dx, w-dx
	}
	if r.edge&edgeRight != 0 {
		w += dx
	}
	if r.edge&edgeTop != 0 {
		y, h = y+dy, h-dy
	}
	if r.edge&edgeBottom != 0 {
		h += dy
	}
	zoom := sh.context.Paint.Zoom * r.unit
	lw, lh := sh.leastSize()
	minW, minH := int(lw*zoom), int(lh*zoom)
	if w < minW {
		if r.edge&edgeLeft != 0 {
			x -= minW - w
		}
		w = minW
	}
	if h < minH {
		if r.edge&edgeTop != 0 {
			y -= minH - h
		}
		h = minH
	}
	platform.SetWindowRect(sh.window, x, y, w, h)
}

// drawOutline traces the edge of a window the program draws itself, which the system gives no border of its own.
func (sh *Shell) drawOutline(c *widget.Context, bounds geom.Rect) {
	if frame != frameApp || sh.isMaximized() || rl.IsWindowFullscreen() {
		return
	}
	c.Paint.Stroke(bounds, 0, c.Hairline(), theme.WithAlpha(c.Theme.Text, outlineAlpha))
}
