package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	statusPaddingY   = 10
	statusPaddingX   = 12
	statusGap        = 10
	statusRadius     = 8
	statusTextSize   = 13
	statusTextLine   = 1.45
	statusTickWidth  = 11.9
	statusCrossWidth = 10.1
	statusMarkInk    = 1.6
)

// StatusRow is one line of a checklist: a tick or a cross, then what it says.
type StatusRow struct {
	OK   bool
	Text string
}

func (s StatusRow) text() *Text {
	return &Text{Content: s.Text, Tone: ToneText, Wrap: true, Style: paint.TextStyle{Size: statusTextSize, Weight: paint.Regular}, LineHeight: statusTextSize * statusTextLine}
}

func (s StatusRow) markWidth() float32 {
	if s.OK {
		return statusTickWidth
	}
	return statusCrossWidth
}

func (s StatusRow) textWidth(c *Context, maxWidth float32) float32 {
	return maxWidth - 2*(statusPaddingX+c.Hairline()) - s.markWidth() - statusGap
}

func (s StatusRow) Measure(c *Context, maxWidth float32) geom.Size {
	h := s.text().Measure(c, s.textWidth(c, maxWidth)).H
	return geom.Size{W: maxWidth, H: h + 2*(statusPaddingY+c.Hairline())}
}

func (s StatusRow) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(r, statusRadius, c.Theme.Surface2)
	c.Paint.Stroke(r, statusRadius, c.Hairline(), c.Theme.Border)
	inner := r.Inset(statusPaddingX+c.Hairline(), statusPaddingY+c.Hairline(), statusPaddingX+c.Hairline(), statusPaddingY+c.Hairline())
	s.drawMark(c, geom.Rect{X: inner.X, Y: inner.Y, W: s.markWidth(), H: statusTextSize * statusTextLine})
	s.text().Draw(c, geom.Rect{X: inner.X + s.markWidth() + statusGap, Y: inner.Y, W: s.textWidth(c, r.W), H: inner.H})
}

func (s StatusRow) drawMark(c *Context, box geom.Rect) {
	cx, cy := box.X+box.W/2, box.Y+box.H/2
	if s.OK {
		ink := c.Theme.Live
		c.Paint.Line(cx-4.5, cy+0.2, cx-1.5, cy+3.4, statusMarkInk, ink)
		c.Paint.Line(cx-1.7, cy+3.4, cx+4.5, cy-3.6, statusMarkInk, ink)
		return
	}
	ink := c.Theme.Danger
	c.Paint.Line(cx-4, cy-4, cx+4, cy+4, statusMarkInk, ink)
	c.Paint.Line(cx-4, cy+4, cx+4, cy-4, statusMarkInk, ink)
}
