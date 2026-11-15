package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	rowsRadius   = 8
	rowPadY      = 8.8
	rowPadX      = 12.8
	rowGap       = 16
	rowSize      = 14.08
	rowLine      = rowSize * 1.5
	rowHintSize  = 12
	rowHintLine  = rowHintSize * 1.5
	rowHintLead  = 23.1
	rowLeadGap   = 4
	rowMargin    = 12.8
	rowBandPadY  = 7.2
	rowBandPadX  = 12.8
	rowBandAlpha = 0.04
)

const captionLine = dialogLabelSize * 1.5

var (
	captionStyle = paint.TextStyle{Size: dialogLabelSize, Weight: paint.Semibold, Spacing: fieldLabelSpacing}
	rowStyle     = paint.TextStyle{Size: rowSize, Weight: paint.Regular}
	rowHintStyle = paint.TextStyle{Size: rowHintSize, Weight: paint.Regular}
)

// SwitchRow is one yes-or-no in a SwitchRows: what it is, before it an optional lead (a role's dot, a badge), under it a quiet hint.
type SwitchRow struct {
	Lead     Component
	Label    string
	Hint     string
	Sw       Switch
	Disabled bool
	OnChange func(bool)
}

func (r *SwitchRow) hintHeight(c *Context, width float32) float32 {
	return float32(len(wrap(c, r.Hint, rowHintStyle, width))) * rowHintLine
}

func (r *SwitchRow) measure(c *Context, width float32) float32 {
	textW := width - 2*rowPadX - switchWidth - rowGap
	body := float32(rowLine)
	if r.Lead != nil {
		body = max(body, r.Lead.Measure(c, textW).H)
	}
	if r.Hint != "" {
		body = rowHintLead + r.hintHeight(c, textW)
	}
	return 2*rowPadY + max(body, switchHeight) + rowMargin
}

func (r *SwitchRow) draw(c *Context, b geom.Rect) {
	b.H -= rowMargin
	r.Sw.Disabled = r.Disabled
	if !r.Disabled {
		if c.Hovered(b) {
			c.SetCursor(rl.MouseCursorPointingHand)
		}
		if c.Clicked(b) {
			c.Claim()
			r.Sw.Toggle()
			if r.OnChange != nil {
				r.OnChange(r.Sw.On)
			}
		}
	}
	textW := b.W - 2*rowPadX - switchWidth - rowGap
	x := b.X + rowPadX
	top := b.Y + rowPadY
	if r.Hint == "" {
		top = b.Y + (b.H-rowLine)/2
	}
	if r.Lead != nil {
		size := r.Lead.Measure(c, textW)
		r.Lead.Draw(c, geom.Rect{X: x, Y: b.Y + (b.H-size.H)/2, W: size.W, H: size.H})
		x += size.W + rowLeadGap
	}
	c.Paint.TextIn(geom.Rect{X: x, Y: b.Y, W: b.Right() - rowPadX - switchWidth - rowGap - x, H: b.H}, r.Label, x, top, rowLine, rowStyle, c.Theme.Text)
	if r.Hint != "" {
		for i, line := range wrap(c, r.Hint, rowHintStyle, textW) {
			c.Paint.Text(line, b.X+rowPadX, top+rowHintLead+float32(i)*rowHintLine, rowHintLine, rowHintStyle, c.Theme.Muted)
		}
	}
	r.Sw.paint(c, geom.Rect{X: b.Right() - rowPadX - switchWidth, Y: b.Y + (b.H-switchHeight)/2, W: switchWidth, H: switchHeight})
}

// SwitchRows is a block of yes-or-no rows in one bordered box with a rule between them. Its Label is a caption over the box, or with
// Banded a tinted band at the top of the box.
type SwitchRows struct {
	Label  string
	Banded bool
	Rows   []*SwitchRow
}

func (s *SwitchRows) band(c *Context) float32 {
	if !s.Banded || s.Label == "" {
		return 0
	}
	return rowBandPadY*2 + captionLine
}

func (s *SwitchRows) box(c *Context, width float32) float32 {
	h := s.band(c) + 2*c.Hairline()
	for i, r := range s.Rows {
		h += r.measure(c, width-2*c.Hairline())
		if i > 0 {
			h += c.Hairline()
		}
	}
	return h
}

func (s *SwitchRows) caption() float32 {
	if s.Label == "" || s.Banded {
		return 0
	}
	return captionLine + dialogLabelGap
}

func (s *SwitchRows) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: s.caption() + s.box(c, maxWidth)}
}

func (s *SwitchRows) Draw(c *Context, r geom.Rect) {
	if caption := s.caption(); caption > 0 {
		c.Paint.Text(Upper(s.Label), r.X, r.Y, captionLine, captionStyle, c.Theme.Muted)
		r.Y += caption
		r.H -= caption
	}
	edge := c.Hairline()
	c.Paint.Stroke(r, rowsRadius, edge, c.Theme.Border)
	inner := r.InsetAll(edge)
	c.Paint.PushClip(inner)
	y := inner.Y
	if band := s.band(c); band > 0 {
		c.Paint.Fill(geom.Rect{X: inner.X, Y: y, W: inner.W, H: band}, 0, theme.WithAlpha(c.Theme.Tint, rowBandAlpha))
		c.Paint.Text(Upper(s.Label), inner.X+rowBandPadX, y+rowBandPadY, captionLine, captionStyle, c.Theme.Muted)
		y += band
	}
	for i, row := range s.Rows {
		if i > 0 {
			c.Paint.Fill(geom.Rect{X: inner.X, Y: y, W: inner.W, H: edge}, 0, c.Theme.Border)
			y += edge
		}
		h := row.measure(c, inner.W)
		row.draw(c, geom.Rect{X: inner.X, Y: y, W: inner.W, H: h})
		y += h
	}
	c.Paint.PopClip()
}

const dotSize = 9.9

// Dot is the small round mark in a role's colour.
type Dot struct{ Color color.RGBA }

func (Dot) Measure(*Context, float32) geom.Size { return geom.Size{W: dotSize, H: dotSize} }

func (d Dot) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y + (r.H-dotSize)/2, W: dotSize, H: dotSize}, dotSize/2, d.Color)
}
