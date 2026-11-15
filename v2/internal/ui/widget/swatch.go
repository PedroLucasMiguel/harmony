package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	swatchPad    = 4.8
	swatchRadius = 8
	swatchBands  = 32
	swatchBandR  = 5
	swatchGap    = 4.8
	swatchSize   = 11.52
	swatchLine   = swatchSize * 1.5
)

var swatchStyle = paint.TextStyle{Size: swatchSize, Weight: paint.Regular}

// Swatch offers a colour palette: three bands of its own colours over its name, ringed in the accent while it is chosen.
type Swatch struct {
	Label   string
	Bands   [3]color.RGBA
	On      bool
	OnClick func()
}

func (s Swatch) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: 2*(swatchPad+c.Hairline()) + swatchBands + swatchGap + swatchLine}
}

func (s Swatch) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	edge := c.Theme.Border
	switch {
	case s.On:
		edge = c.Theme.Accent
		c.Paint.Stroke(r.InsetAll(-c.Hairline()), swatchRadius+c.Hairline(), c.Hairline(), edge)
	case hovered:
		edge = c.Theme.BorderStrong
	}
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	c.Paint.Fill(r, swatchRadius, c.Theme.Surface)
	c.Paint.Stroke(r, swatchRadius, c.Hairline(), edge)
	inner := r.InsetAll(c.Hairline() + swatchPad)
	band := inner.W / 3
	c.Paint.Fill(geom.Rect{X: inner.X, Y: inner.Y, W: inner.W, H: swatchBands}, swatchBandR, s.Bands[0])
	c.Paint.Fill(geom.Rect{X: inner.X + band, Y: inner.Y, W: band, H: swatchBands}, 0, s.Bands[1])
	c.Paint.Fill(geom.Rect{X: inner.X + 2*band, Y: inner.Y, W: band - swatchBandR, H: swatchBands}, 0, s.Bands[2])
	c.Paint.Fill(geom.Rect{X: inner.Right() - 2*swatchBandR, Y: inner.Y, W: 2 * swatchBandR, H: swatchBands}, swatchBandR, s.Bands[2])
	width := c.Paint.TextWidth(s.Label, swatchStyle)
	c.Paint.Text(s.Label, inner.X+(inner.W-width)/2, inner.Y+swatchBands+swatchGap, swatchLine, swatchStyle, c.Theme.Text)
	if c.Clicked(r) {
		c.Claim()
		if s.OnClick != nil {
			s.OnClick()
		}
	}
}
