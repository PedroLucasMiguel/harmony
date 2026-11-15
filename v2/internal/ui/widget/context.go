// Package widget holds the reusable interface components and the layout they are arranged with.
package widget

import (
	"sync"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/faces"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/input"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/raw"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

type Component interface {
	Measure(c *Context, maxWidth float32) geom.Size
	Draw(c *Context, r geom.Rect)
}

type Context struct {
	Paint    *paint.Painter
	Theme    theme.Palette
	Strings  *i18n.Bundle
	In       input.State
	Dt       float32
	Viewport geom.Size
	// People and Faces are who is on the signed-in server and their pictures; nil before sign-in.
	People *people.Directory
	Faces  *faces.Store
	// Frame counts the frames drawn; a gap in it means a frame ran that did not ask for something.
	Frame uint64
	// OpenProfile opens the profile card of a person beside the rectangle that was pressed; set by the screen that shows it.
	OpenProfile func(userID int, anchor geom.Rect)

	focus      *Focus
	focusable  []*Focus
	claimed    bool
	cursor     int32
	overlays   []func()
	lastFrame  time.Time
	active     bool
	postMu     sync.Mutex
	posted     []func()
	modalMu    sync.Mutex
	modal      Modal
	popups     []geom.Rect
	nextPopup  []geom.Rect
	inOverlay  bool
	underPopup bool
	layers     []any
	top        any
}

// Modal is a layer drawn over the whole window that takes every click while it is open.
type Modal interface {
	Draw(c *Context, bounds geom.Rect)
}

type Focus struct{}

func (c *Context) BeginFrame(in input.State) {
	c.beginLayers()
	c.runPosted()
	c.Frame++
	c.In = in
	c.Dt = c.elapsed()
	c.In.MouseX = c.Paint.ToCSS(c.In.MouseX)
	c.In.MouseY = c.Paint.ToCSS(c.In.MouseY)
	c.focusable = c.focusable[:0]
	c.overlays = c.overlays[:0]
	c.popups, c.nextPopup = c.nextPopup, c.popups[:0]
	c.underPopup = false
	for _, r := range c.popups {
		c.underPopup = c.underPopup || r.Contains(c.In.MouseX, c.In.MouseY)
	}
	c.claimed = false
	c.cursor = rl.MouseCursorDefault
}

func (c *Context) EndFrame() {
	c.inOverlay = true
	for _, draw := range c.overlays {
		draw()
	}
	c.inOverlay = false
	c.Paint.Flush()
	c.moveFocus()
	if c.In.Pressed && !c.claimed {
		c.focus = nil
	}
	raw.SetMouseCursor(c.cursor)
}

func (c *Context) moveFocus() {
	if len(c.focusable) == 0 || (!c.In.Tab && !c.In.ShiftTab) {
		return
	}
	at := -1
	for i, f := range c.focusable {
		if f == c.focus {
			at = i
		}
	}
	step := 1
	if c.In.ShiftTab {
		step = -1
	}
	c.focus = c.focusable[(at+step+len(c.focusable))%len(c.focusable)]
}

const (
	nominalFrame = 16 * time.Millisecond
	idleGap      = 100 * time.Millisecond
)

// elapsed is the time since the last frame, or one nominal frame when the window was asleep in between.
func (c *Context) elapsed() float32 {
	now := time.Now()
	gap := now.Sub(c.lastFrame)
	c.lastFrame = now
	if gap > idleGap {
		gap = nominalFrame
	}
	return float32(gap.Seconds())
}

func (c *Context) T(key string, vars ...string) string { return c.Strings.T(key, vars...) }

func (c *Context) Hairline() float32 { return 1 / c.Paint.Zoom }

func (c *Context) Hovered(r geom.Rect) bool {
	return r.Contains(c.In.MouseX, c.In.MouseY) && (c.inOverlay || !c.underPopup)
}

// Popup marks an area drawn over the rest, so what is under it stops reacting to the mouse from the next frame on.
func (c *Context) Popup(r geom.Rect) { c.nextPopup = append(c.nextPopup, r) }

func (c *Context) Clicked(r geom.Rect) bool { return c.In.Pressed && c.Hovered(r) }

func (c *Context) Claim() { c.claimed = true }

// Claimed tells whether a press this frame was taken by something already.
func (c *Context) Claimed() bool { return c.claimed }

// HasFocus tells whether any component holds the keyboard.
func (c *Context) HasFocus() bool { return c.focus != nil }

func (c *Context) SetCursor(cursor int32) { c.cursor = cursor }

func (c *Context) Overlay(draw func()) { c.overlays = append(c.overlays, draw) }

func (c *Context) Register(f *Focus) { c.focusable = append(c.focusable, f) }

func (c *Context) Focused(f *Focus) bool { return c.focus == f }

func (c *Context) Focus(f *Focus) { c.focus = f }

// OpenModal shows m over everything, in place of any modal already open; safe from any goroutine.
func (c *Context) OpenModal(m Modal) {
	c.modalMu.Lock()
	c.modal = m
	c.modalMu.Unlock()
	redraw.Request()
}

func (c *Context) CloseModal() {
	c.modalMu.Lock()
	c.modal = nil
	c.modalMu.Unlock()
	redraw.Request()
}

func (c *Context) Modal() Modal {
	c.modalMu.Lock()
	defer c.modalMu.Unlock()
	return c.modal
}

// Frozen runs draw as if nothing was pressed and the mouse was away, so what is under a modal stays still.
func (c *Context) Frozen(draw func()) {
	saved := c.In
	c.In = input.State{MouseX: -1e6, MouseY: -1e6}
	draw()
	c.In = saved
}

// Post runs fn on the interface's own thread at the start of the next frame; safe from any goroutine.
func (c *Context) Post(fn func()) {
	c.postMu.Lock()
	c.posted = append(c.posted, fn)
	c.postMu.Unlock()
	redraw.Request()
}

func (c *Context) runPosted() {
	c.postMu.Lock()
	run := c.posted
	c.posted = nil
	c.postMu.Unlock()
	for _, fn := range run {
		fn()
	}
}
