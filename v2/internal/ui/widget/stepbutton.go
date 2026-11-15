package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
)

const (
	stepButtonSize   = 32
	stepButtonRadius = 8
	stepGlyphHalf    = 4.4
	stepGlyphWidth   = 1.8
)

// StepButton is the square minus or plus at the end of a slider.
type StepButton struct {
	Plus    bool
	OnClick func()
}

func (b StepButton) Measure(*Context, float32) geom.Size {
	return geom.Size{W: stepButtonSize, H: stepButtonSize}
}

func (b StepButton) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	ink, edge := c.Theme.Text, c.Theme.Border
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		ink, edge = c.Theme.Accent, c.Theme.Accent
	}
	c.Paint.Fill(r, stepButtonRadius, c.Theme.Surface2)
	c.Paint.Stroke(r, stepButtonRadius, c.Hairline(), edge)
	cx, cy := r.X+r.W/2, r.Y+r.H/2
	c.Paint.Line(cx-stepGlyphHalf, cy, cx+stepGlyphHalf, cy, stepGlyphWidth, ink)
	if b.Plus {
		c.Paint.Line(cx, cy-stepGlyphHalf, cx, cy+stepGlyphHalf, stepGlyphWidth, ink)
	}
	if c.Clicked(r) {
		c.Claim()
		if b.OnClick != nil {
			b.OnClick()
		}
	}
}
