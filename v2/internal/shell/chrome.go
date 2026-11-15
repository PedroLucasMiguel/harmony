package shell

import (
	"os"
	"runtime"
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/platform"
	"harmony/v2/internal/screens/about"
	"harmony/v2/internal/ui/geom"
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
}

type dragState struct {
	on     bool
	ox, oy float32
}

type resizeState struct {
	on         bool
	edge       edge
	mx, my     float32
	x, y, w, h int
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
		OnBack:        func() { sh.navigate(false) },
		OnForward:     func() { sh.navigate(true) },
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
	sh.chrome.drag = dragState{on: true, ox: sh.in.MouseX, oy: sh.in.MouseY}
}

func (sh *Shell) toggleMaximize() {
	sh.chrome.drag.on = false
	if frame == frameMac {
		platform.ToggleZoom(sh.window)
		return
	}
	if rl.IsWindowMaximized() {
		rl.RestoreWindow()
	} else {
		rl.MaximizeWindow()
	}
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
	b.CanBack = sh.channels != nil && sh.channels.CanGoBack()
	b.CanForward = sh.channels != nil && sh.channels.CanGoForward()
	b.Left = 0
	if frame == frameMac && !ch.fullscreen {
		b.Left = macLeft
	}
	b.Maximized = frame == frameApp && rl.IsWindowMaximized()
	b.Draw(c, geom.Rect{X: bounds.X, Y: bounds.Y, W: bounds.W, H: widget.TitleBarHeight})
}

// chromeInput moves the window while the bar is dragged and keeps the system's buttons where the bar expects them. It runs once per input poll.
func (sh *Shell) chromeInput() {
	ch := &sh.chrome
	if ch.drag.on {
		if !sh.in.Down {
			ch.drag.on = false
		} else if dx, dy := sh.in.MouseX-ch.drag.ox, sh.in.MouseY-ch.drag.oy; dx != 0 || dy != 0 {
			pos := rl.GetWindowPosition()
			rl.SetWindowPosition(int(pos.X+dx), int(pos.Y+dy))
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
	if rl.IsWindowMaximized() || rl.IsWindowFullscreen() {
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
		zoom := sh.context.Paint.Zoom
		minW, minH := int(minWindowWidth*zoom), int(minWindowHeight*zoom)
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
	if sh.in.Pressed {
		pos := rl.GetWindowPosition()
		*r = resizeState{on: true, edge: e, mx: sh.in.MouseX + pos.X, my: sh.in.MouseY + pos.Y, x: int(pos.X), y: int(pos.Y), w: sh.width, h: sh.height}
	}
}
