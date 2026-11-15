package serveradmin

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	toggleTitleSize = 14.08
	toggleHintSize  = 12
	toggleHintGap   = 2.4
	toggleGap       = 16
)

var (
	toggleTitleStyle = paint.TextStyle{Size: toggleTitleSize, Weight: paint.Regular}
	toggleHintStyle  = paint.TextStyle{Size: toggleHintSize, Weight: paint.Regular}
)

// plainToggle is a yes-or-no on its own in the editor, not inside a bordered block: what it is and a hint on the left, the switch on
// the right.
type plainToggle struct {
	title, hint string
	sw          *widget.Switch
}

func (t plainToggle) hintText() *widget.Text {
	return &widget.Text{Content: t.hint, Style: toggleHintStyle, LineHeight: toggleHintSize * 1.5, Tone: widget.ToneMuted, Wrap: true}
}

func (t plainToggle) Measure(c *widget.Context, width float32) geom.Size {
	text := float32(toggleTitleSize * 1.5)
	if t.hint != "" {
		text += toggleHintGap + t.hintText().Measure(c, width-toggleGap-t.sw.Measure(c, 0).W).H
	}
	return geom.Size{W: width, H: max(text, t.sw.Measure(c, 0).H)}
}

func (t plainToggle) Draw(c *widget.Context, r geom.Rect) {
	size := t.sw.Measure(c, 0)
	knob := geom.Rect{X: r.Right() - size.W, Y: r.Y + (r.H-size.H)/2, W: size.W, H: size.H}
	if !t.sw.Disabled && !knob.Contains(c.In.MouseX, c.In.MouseY) {
		if c.Hovered(r) {
			c.SetCursor(rl.MouseCursorPointingHand)
		}
		if c.Clicked(r) {
			c.Claim()
			t.sw.Toggle()
		}
	}
	c.Paint.Text(t.title, r.X, r.Y, toggleTitleSize*1.5, toggleTitleStyle, c.Theme.Text)
	if t.hint != "" {
		t.hintText().Draw(c, geom.Rect{X: r.X, Y: r.Y + toggleTitleSize*1.5 + toggleHintGap, W: r.W - toggleGap - size.W, H: r.H})
	}
	t.sw.Draw(c, knob)
}
