package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

type popoverStyle struct {
	padding, radius, gap, shadowY, blur float32
	shadowAlpha                         uint8
	raised                              bool
}

const popoverMargin = 8

var (
	popoverTight = popoverStyle{padding: 5.6, radius: 12, gap: 6, shadowY: 10, blur: 30, shadowAlpha: 115}
	popoverRoomy = popoverStyle{padding: 9.6, radius: 10, gap: 8, shadowY: 12, blur: 32, shadowAlpha: 140, raised: true}
)

const popoverRoomyEdge = 0.14

// Popover is a panel hung from a rectangle and drawn over everything: above it when there is room, else below.
// A press outside it, or Escape, closes it; a press on the trigger is left to the trigger, which toggles it.
// Roomy gives it more padding and the raised surface, for a panel that holds a whole small screen.
type Popover struct {
	Roomy bool
	// Keep, when it says true, stops a press outside from closing the panel: something that belongs to it is open over it.
	Keep func() bool

	open  bool
	fresh bool

	// what the overlay needs, kept so that showing it allocates nothing
	anchor, trigger geom.Rect
	size            geom.Size
	body            func(content geom.Rect)
	paint           func(c *Context)
}

func (p *Popover) IsOpen() bool { return p.open }

func (p *Popover) Open() { p.open, p.fresh = true, true }

func (p *Popover) Close() { p.open = false }

func (p *Popover) Toggle() {
	if p.open {
		p.Close()
		return
	}
	p.Open()
}

func (p *Popover) style() popoverStyle {
	if p.Roomy {
		return popoverRoomy
	}
	return popoverTight
}

// Frame is what the panel adds around its content on each side.
func (p *Popover) Frame(c *Context) float32 { return p.style().padding + c.Hairline() }

// PopoverMargin is the least space kept between the panel and the window's edge.
func PopoverMargin() float32 { return popoverMargin }

// Draw shows the panel while it is open; body paints into the content area it is given.
func (p *Popover) Draw(c *Context, anchor, trigger geom.Rect, content geom.Size, body func(content geom.Rect)) {
	if !p.open {
		return
	}
	p.anchor, p.trigger, p.size, p.body = anchor, trigger, content, body
	if p.paint == nil {
		p.paint = p.draw
	}
	c.Overlay(func() { p.paint(c) })
}

func (p *Popover) draw(c *Context) {
	style := p.style()
	frame := p.Frame(c)
	box := geom.Rect{W: p.size.W + 2*frame, H: p.size.H + 2*frame}
	box.X = max(popoverMargin, min(p.anchor.X, c.Viewport.W-box.W-popoverMargin))
	box.Y = p.anchor.Y - style.gap - box.H
	if box.Y < popoverMargin {
		box.Y = min(p.anchor.Bottom()+style.gap, max(popoverMargin, c.Viewport.H-box.H-popoverMargin))
	}
	c.Popup(box)
	c.Layer(p)

	inside := box.Contains(c.In.MouseX, c.In.MouseY)
	outside := (c.In.Pressed && !p.trigger.Contains(c.In.MouseX, c.In.MouseY)) || c.In.RightPressed
	if !p.fresh && (c.EscapeFor(p) && (p.Keep == nil || !p.Keep()) || outside && !inside && (p.Keep == nil || !p.Keep())) {
		p.open = false
		return
	}
	p.fresh = false
	if style.raised && inside && c.In.Pressed {
		c.Claim()
	}

	c.Paint.Shadow(box, style.radius, style.shadowY, style.blur, color.RGBA{A: style.shadowAlpha})
	fill, edge := c.Theme.Surface, c.Theme.BorderStrong
	if style.raised {
		fill, edge = c.Theme.Surface2, theme.WithAlpha(c.Theme.Tint, popoverRoomyEdge)
	}
	c.Paint.Fill(box, style.radius, fill)
	c.Paint.Stroke(box, style.radius, c.Hairline(), edge)
	p.body(box.InsetAll(frame))
}
