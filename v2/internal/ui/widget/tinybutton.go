package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
)

const (
	tinyIcon   = 13.44
	tinyPadX   = 4.8
	tinyRadius = 8
)

// TinyButton is a small plate with one icon, the size of a line of small text: the mute button beside a volume slider.
type TinyButton struct {
	Icon    string
	OnClick func()
}

func (b TinyButton) Measure(c *Context, _ float32) geom.Size {
	return geom.Size{W: tinyIcon + 2*(tinyPadX+c.Hairline()), H: tinyIcon + 2*c.Hairline()}
}

func (b TinyButton) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	c.Paint.Fill(r, tinyRadius, c.Theme.Surface2)
	c.Paint.Stroke(r, tinyRadius, c.Hairline(), c.Theme.Border)
	c.Paint.Icon(b.Icon, geom.Rect{X: r.X + (r.W-tinyIcon)/2, Y: r.Y + (r.H-tinyIcon)/2, W: tinyIcon, H: tinyIcon}, c.Theme.Text)
	if hovered && c.In.Pressed {
		c.Claim()
		if b.OnClick != nil {
			b.OnClick()
		}
	}
}
