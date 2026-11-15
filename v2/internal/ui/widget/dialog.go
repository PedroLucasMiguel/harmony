package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	dialogWidth    = 380
	dialogMargin   = 24
	dialogPadding  = 20
	dialogGap      = 14
	dialogTitle    = 17
	dialogBackdrop = 153
)

// Dialog is a titled card centred over the window; a click outside it, or Escape, closes it.
type Dialog struct {
	Title    string
	Children []Component
	OnClose  func()
}

func (d *Dialog) Draw(c *Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: dialogBackdrop})

	title := &Text{Content: d.Title, Tone: ToneText, Style: paint.TextStyle{Size: dialogTitle, Weight: paint.Semibold}}
	body := Col(dialogGap, append([]Component{title}, d.Children...)...)
	edge := c.Hairline()
	width := min(dialogWidth, bounds.W-2*dialogMargin)
	inner := width - 2*(dialogPadding+edge)
	height := body.Measure(c, inner).H + 2*(dialogPadding+edge)
	card := geom.Rect{X: bounds.X + (bounds.W-width)/2, Y: bounds.Y + (bounds.H-height)/2, W: width, H: height}

	c.Layer(d)
	if (c.Clicked(bounds) && !c.Hovered(card)) || c.EscapeFor(d) {
		c.Claim()
		d.OnClose()
		return
	}
	c.Paint.Fill(card, c.Theme.Radius, c.Theme.Surface)
	c.Paint.Stroke(card, c.Theme.Radius, edge, c.Theme.Border)
	body.Draw(c, card.InsetAll(dialogPadding+edge))
}
