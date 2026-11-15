package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	segPad        = 4
	segGap        = 4
	segRadius     = 10
	segItemRadius = 7
	segItemPadY   = 7
	segItemPadX   = 10
	segSize       = 13
)

var segStyle = paint.TextStyle{Size: segSize, Weight: paint.Regular}

// Segmented is one choice out of a few, all of them visible, in a well: the picker's source type and the quality rows.
type Segmented struct {
	Options  []Option
	Value    string
	OnChange func(string)
	Disabled bool
}

func (s *Segmented) Measure(c *Context, maxWidth float32) geom.Size {
	edge := c.Hairline()
	return geom.Size{W: maxWidth, H: segSize*1.5 + 2*segItemPadY + 2*(segPad+edge)}
}

func (s *Segmented) Draw(c *Context, r geom.Rect) {
	edge := c.Hairline()
	c.Paint.Fill(r, segRadius, c.Theme.Bg)
	c.Paint.Stroke(r, segRadius, edge, c.Theme.Border)
	if len(s.Options) == 0 {
		return
	}
	inner := r.InsetAll(segPad + edge)
	n := float32(len(s.Options))
	w := (inner.W - (n-1)*segGap) / n
	for i, o := range s.Options {
		item := geom.Rect{X: inner.X + float32(i)*(w+segGap), Y: inner.Y, W: w, H: inner.H}
		active := o.Value == s.Value
		hovered := !s.Disabled && c.Hovered(item)
		ink := c.Theme.Muted
		switch {
		case active:
			c.Paint.Fill(item, segItemRadius, c.Theme.Accent)
			ink = ToneOnAccent.Color(c.Theme)
		case hovered:
			c.Paint.Fill(item, segItemRadius, c.Theme.Surface2)
			ink = c.Theme.Text
		}
		if s.Disabled {
			ink = fade(ink, true)
		}
		tw := c.Paint.TextWidth(o.Label, segStyle)
		clip := item.InsetAll(0)
		c.Paint.TextIn(clip, o.Label, item.X+max(segItemPadX/2, (item.W-tw)/2), item.Y+(item.H-segSize*1.5)/2, segSize*1.5, segStyle, ink)
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.In.Pressed {
				c.Claim()
				if !active && s.OnChange != nil {
					s.OnChange(o.Value)
				}
			}
		}
	}
}
