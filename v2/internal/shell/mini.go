package shell

import (
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/platform"
	"harmony/v2/internal/screens/channels"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/raw"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	// miniGrace is how long the app stays minimised before it becomes the window of streams, so a flick away and back does not.
	miniGrace     = 400 * time.Millisecond
	miniMinWidth  = 220
	miniMinHeight = 150
	miniUsualW    = 380
	miniUsualH    = 250
	miniMargin    = 24
	miniShelf     = 60
)

// miniState is the app as the picture in picture window: small, on top of everything, showing one stream. It takes the app's
// place while the app is minimised (auto) or when asked to by hand, and gives it back.
type miniState struct {
	on bool
	// auto is a mini that came from the app being minimised, which goes back to being minimised.
	auto bool
	// since is when the app was minimised, and waking that it was asked to come out of it.
	since  time.Time
	waking bool
	// away is that the app has been minimised since the window was last closed for now.
	away bool

	back      screenRect
	ownMax    bool
	systemMax bool
}

// leastSize is the smallest the window may be made, in interface pixels.
func (sh *Shell) leastSize() (w, h float32) {
	if sh.mini.on {
		return miniMinWidth, miniMinHeight
	}
	return minWindowWidth, minWindowHeight
}

func (sh *Shell) applyMinSize() {
	w, h := sh.leastSize()
	zoom := sh.context.Paint.Zoom
	rl.SetWindowMinSize(int(w*zoom), int(h*zoom))
}

func (sh *Shell) miniHooks() channels.MiniHooks {
	return channels.MiniHooks{
		Out:    func() { sh.context.Post(func() { sh.enterMini(false) }) },
		In:     func(bool) { sh.context.Post(sh.bringBack) },
		Move:   sh.startDrag,
		Closed: func() { sh.context.Post(func() { sh.exitMini(sh.mini.auto) }) },
	}
}

// bringBack is the window of streams giving the app back, shown and in front.
func (sh *Shell) bringBack() {
	sh.exitMini(false)
	sh.mini.away = false
	if sh.channels != nil {
		sh.channels.PipRevive()
	}
}

// showMain brings the app to the front from outside (the tray, a second start), which ends the window of streams.
func (sh *Shell) showMain() {
	if sh.mini.on {
		sh.exitMini(false)
	}
	showWindow()
}

// syncMini turns the minimised app into the window of streams and back. It runs once per input poll, so it costs a few
// reads while nothing is going on.
func (sh *Shell) syncMini() {
	m := &sh.mini
	ch := sh.channels
	if ch == nil || sh.screen != Screen(ch) {
		if m.on {
			sh.exitMini(false)
		}
		m.since, m.waking = time.Time{}, false
		return
	}
	minimized := raw.IsWindowMinimized()
	switch {
	case m.on:
		if !ch.PipReady() {
			sh.exitMini(m.auto)
		}
	case minimized:
		m.away = true
		if m.waking || !ch.PipAuto() {
			m.since = time.Time{}
			return
		}
		if m.since.IsZero() {
			m.since = time.Now()
		}
		if left := miniGrace - time.Since(m.since); left > 0 {
			redraw.After(left)
			return
		}
		m.waking = true
		rl.RestoreWindow()
	case m.waking:
		m.waking, m.since = false, time.Time{}
		if ch.PipAuto() {
			sh.enterMini(true)
		}
	default:
		m.since = time.Time{}
		if m.away {
			m.away = false
			ch.PipRevive()
		}
	}
}

// enterMini makes the app the window of streams in the lower right corner of the screen it is on.
func (sh *Shell) enterMini(auto bool) {
	m, ch := &sh.mini, &sh.chrome
	if m.on || sh.channels == nil || rl.IsWindowFullscreen() {
		return
	}
	x, y, w, h, ok := platform.WindowRect(sh.window)
	unit := float32(1)
	if ok {
		unit = float32(w) / float32(max(raw.GetScreenWidth(), 1))
	} else {
		pos := rl.GetWindowPosition()
		x, y, w, h = int(pos.X), int(pos.Y), raw.GetScreenWidth(), raw.GetScreenHeight()
	}
	m.back, m.auto, m.ownMax = screenRect{x, y, w, h}, auto, ch.maximized
	m.systemMax = !ownMaximize() && rl.IsWindowMaximized()
	if m.systemMax {
		rl.RestoreWindow()
	}
	ch.maximized, ch.drag.on, ch.resize.on = false, false, false
	m.on = true
	sh.channels.SetMini(true)

	zoom := sh.context.Paint.Zoom
	size := sh.settings.PipRect
	if size.W == 0 {
		size.W, size.H = miniUsualW, miniUsualH
	}
	pw, ph := int(size.W*zoom*unit), int(size.H*zoom*unit)
	area := sh.workArea()
	sh.applyMinSize()
	sh.placeWindow(screenRect{area.x + area.w - pw - int(miniMargin*unit), area.y + area.h - ph - int(miniMargin*unit), pw, ph})
	rl.SetWindowState(rl.FlagWindowTopmost)
	redraw.Request()
}

// exitMini gives the app its place back, minimised again when asked.
func (sh *Shell) exitMini(minimize bool) {
	m, ch := &sh.mini, &sh.chrome
	if !m.on {
		return
	}
	m.on, m.waking, m.since = false, false, time.Time{}
	if sh.channels != nil {
		sh.channels.SetMini(false)
	}
	rl.ClearWindowState(rl.FlagWindowTopmost)
	sh.applyMinSize()
	sh.placeWindow(m.back)
	ch.maximized = m.ownMax
	if m.systemMax {
		rl.MaximizeWindow()
	}
	if minimize {
		rl.MinimizeWindow()
	} else {
		rl.SetWindowFocused()
		platform.Activate()
	}
	redraw.Request()
}

func (sh *Shell) placeWindow(r screenRect) {
	if !platform.SetWindowRect(sh.window, r.x, r.y, r.w, r.h) {
		rl.SetWindowPosition(r.x, r.y)
		rl.SetWindowSize(r.w, r.h)
	}
}

// workArea is the part of the screen the window is on that the taskbar and dock leave free, or the whole screen less a shelf
// where the system cannot say.
func (sh *Shell) workArea() screenRect {
	if ax, ay, aw, ah, ok := platform.WorkArea(sh.window); ok {
		return screenRect{ax, ay, aw, ah}
	}
	monitor := rl.GetCurrentMonitor()
	pos := rl.GetMonitorPosition(monitor)
	return screenRect{int(pos.X), int(pos.Y), rl.GetMonitorWidth(monitor), rl.GetMonitorHeight(monitor) - miniShelf}
}

// drawMini draws the window of streams over the whole window.
func (sh *Shell) drawMini(c *widget.Context, bounds geom.Rect) {
	if sh.chrome.hover != 0 {
		c.SetCursor(cursorFor(sh.chrome.hover))
	}
	left := float32(0)
	if frame == frameMac && !sh.chrome.fullscreen {
		left = macLeft
	}
	sh.channels.DrawMini(c, bounds, left)
}
