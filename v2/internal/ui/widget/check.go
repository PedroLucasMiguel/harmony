package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
)

const (
	checkBoxSize     = 13
	checkBoxTop      = 2
	checkBoxRadius   = 2
	checkGap         = 10
	checkMarginLeft  = 4
	checkMarginRight = 3
)

const checkContentX = checkMarginLeft + checkBoxSize + checkMarginRight + checkGap

type Check struct {
	Checked  bool
	Content  Component
	OnChange func(bool)
}

func (k *Check) Measure(c *Context, maxWidth float32) geom.Size {
	inner := k.Content.Measure(c, maxWidth-checkContentX)
	return geom.Size{W: maxWidth, H: max(inner.H, checkBoxTop+checkBoxSize)}
}

func (k *Check) Draw(c *Context, r geom.Rect) {
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if c.Clicked(r) {
		c.Claim()
		k.Checked = !k.Checked
		if k.OnChange != nil {
			k.OnChange(k.Checked)
		}
	}
	box := geom.Rect{X: r.X + checkMarginLeft, Y: r.Y + checkBoxTop, W: checkBoxSize, H: checkBoxSize}
	if k.Checked {
		c.Paint.Fill(box, checkBoxRadius, c.Theme.Accent)
		c.Paint.Line(box.X+3, box.Y+6.8, box.X+5.6, box.Y+9.4, 1.6, ToneOnAccent.Color(c.Theme))
		c.Paint.Line(box.X+5.4, box.Y+9.4, box.X+10, box.Y+3.8, 1.6, ToneOnAccent.Color(c.Theme))
	} else {
		c.Paint.Stroke(box, checkBoxRadius, c.Hairline(), c.Theme.Muted)
	}
	k.Content.Draw(c, geom.Rect{X: r.X + checkContentX, Y: r.Y, W: r.W - checkContentX, H: r.H})
}
