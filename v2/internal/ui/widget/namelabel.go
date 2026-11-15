package widget

import (
	"image/color"

	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

// NameLabel is a name in its look; with no look it is Ink. A faded one has Opacity under one, a struck one has a line through it.
type NameLabel struct {
	Text    string
	Look    *people.Style
	Face    paint.TextStyle
	Ink     color.RGBA
	Opacity float32
	Strike  bool
}

func (n *NameLabel) line() float32 { return n.Face.Size * 1.5 }

func (n *NameLabel) Measure(c *Context, _ float32) geom.Size {
	return geom.Size{W: c.NameWidth(n.Text, n.Look, n.Face), H: n.line()}
}

func (n *NameLabel) Draw(c *Context, r geom.Rect) {
	ink := n.Ink
	if n.Opacity > 0 && n.Opacity < 1 {
		ink = theme.WithAlpha(ink, n.Opacity*float32(ink.A)/255)
	}
	width := c.DrawName(n.Text, n.Look, r.X, r.Y, n.line(), n.Face, ink)
	if n.Strike {
		y := r.Y + n.line()/2
		c.Paint.Line(r.X, y, r.X+width, y, c.Hairline()*1.2, ink)
	}
}
