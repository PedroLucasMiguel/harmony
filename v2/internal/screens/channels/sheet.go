package channels

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	sheetWidth     = 420
	sheetMargin    = 8
	sheetGap       = 6
	sheetBottom    = 12
	sheetMinHeight = 160
	sheetRadius    = 10
	sheetShadowY   = 12
	sheetBlur      = 32
	sheetShadowA   = 140
	sheetHeadPadY  = 11.2
	sheetHeadPadX  = 14.4
	sheetHeadGap   = 9.6
	sheetHeadIcon  = 17.6
	sheetHeadLine  = 24
	sheetIconAlpha = 0.7
)

var sheetTitle = paint.TextStyle{Size: 16, Weight: paint.Bold}

// sheet is the card that hangs from a button in the chat header, its right edge on the button's, with a titled head and
// a scrolling column of messages: the pinned messages and the starred ones. A press outside it puts it away.
type sheet struct {
	open   bool
	fresh  bool
	scroll widget.Scroll

	c       *widget.Context
	title   string
	icon    string
	ink     color.RGBA
	dim     bool
	anchor  geom.Rect
	from    geom.Rect
	extra   geom.Rect
	minimum float32
	subH    float32
	sub     func(c *widget.Context, r geom.Rect)
	column  *cardColumn
	paint   func()
	bounds  geom.Rect
	// fit builds the cards for the room the list has, once it is known.
	fit func(avail float32)
}

func (sh *sheet) Open() { sh.open, sh.fresh = true, true }

func (sh *sheet) Close() { sh.open = false }

func (sh *sheet) Toggle() {
	if sh.open {
		sh.open = false
		return
	}
	sh.Open()
}

// Contains is whether a point is on the card, for what must not close it.
func (sh *sheet) Contains(x, y float32) bool { return sh.open && sh.bounds.Contains(x, y) }

func (sh *sheet) headHeight(c *widget.Context) float32 {
	return 2*sheetHeadPadY + sheetHeadLine + c.Hairline()
}

// show draws the card over everything while it is open.
func (sh *sheet) show(c *widget.Context) {
	if !sh.open {
		return
	}
	sh.c = c
	if sh.paint == nil {
		sh.paint = sh.draw
		sh.scroll.Bar, sh.scroll.Overlay = true, true
	}
	c.Overlay(sh.paint)
}

func (sh *sheet) draw() {
	c := sh.c
	edge := c.Hairline()
	width := min(sheetWidth, c.Viewport.W-2*sheetMargin)
	top := max(sh.anchor.Bottom(), sh.from.Bottom()) + sheetGap
	box := geom.Rect{X: max(sheetMargin, min(sh.anchor.Right(), c.Viewport.W-sheetMargin)-width), Y: top, W: width}
	head := sh.headHeight(c)
	room := max(sh.minimum, c.Viewport.H-top-sheetBottom)
	sh.fit(room - 2*edge - head - sh.subH)
	content := sh.column.height(c)
	box.H = min(room, 2*edge+head+sh.subH+content)
	sh.bounds = box
	c.Popup(box)

	inside := box.Contains(c.In.MouseX, c.In.MouseY)
	if !sh.fresh && c.In.Pressed && !inside && !sh.anchor.Contains(c.In.MouseX, c.In.MouseY) && !sh.extra.Contains(c.In.MouseX, c.In.MouseY) {
		sh.open = false
		return
	}
	sh.fresh = false
	if inside && c.In.Pressed {
		c.Claim()
	}

	c.Paint.Shadow(box, sheetRadius, sheetShadowY, sheetBlur, color.RGBA{A: sheetShadowA})
	c.Paint.Fill(box, sheetRadius, c.Theme.Surface)
	c.Paint.Stroke(box, sheetRadius, edge, c.Theme.Border)
	inner := box.InsetAll(edge)
	c.Paint.PushClip(inner)
	sh.drawHead(c, geom.Rect{X: inner.X, Y: inner.Y, W: inner.W, H: head})
	y := inner.Y + head
	if sh.sub != nil {
		sh.sub(c, geom.Rect{X: inner.X, Y: y, W: inner.W, H: sh.subH})
		y += sh.subH
	}
	list := geom.Rect{X: inner.X, Y: y, W: inner.W, H: max(0, inner.Bottom()-y)}
	sh.column.view = list
	sh.scroll.Child = sh.column
	sh.scroll.Draw(c, list)
	c.Paint.PopClip()
}

func (sh *sheet) drawHead(c *widget.Context, r geom.Rect) {
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Bottom() - edge, W: r.W, H: edge}, 0, c.Theme.Border)
	ink := sh.ink
	if sh.dim {
		ink = theme.WithAlpha(c.Theme.Text, sheetIconAlpha)
	}
	x := r.X + sheetHeadPadX
	c.Paint.Icon(sh.icon, geom.Rect{X: x, Y: r.Y + (r.H-edge-sheetHeadIcon)/2, W: sheetHeadIcon, H: sheetHeadIcon}, ink)
	c.Paint.Text(sh.title, x+sheetHeadIcon+sheetHeadGap, r.Y+sheetHeadPadY, sheetHeadLine, sheetTitle, c.Theme.Text)
}
