package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	iconButtonW      = 39.3
	iconButtonH      = 31.7
	iconButtonGlyph  = 18
	iconButtonRadius = 8
	iconButtonHover  = 0.1
)

// IconButton is a bare icon in the header of a panel: muted until the pointer is over it, then on a faint plate.
type IconButton struct {
	Icon string
	// Lit shows the icon in the live colour, for something that is on.
	Lit     bool
	OnClick func()
}

func (b IconButton) Measure(*Context, float32) geom.Size {
	return geom.Size{W: iconButtonW, H: iconButtonH}
}

func (b IconButton) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	ink := c.Theme.Muted
	if b.Lit {
		ink = c.Theme.Live
	}
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, iconButtonRadius, theme.WithAlpha(c.Theme.Tint, iconButtonHover))
		if !b.Lit {
			ink = c.Theme.Text
		}
		if c.Clicked(r) {
			c.Claim()
			if b.OnClick != nil {
				b.OnClick()
			}
		}
	}
	c.Paint.Icon(b.Icon, geom.Rect{X: r.X + (r.W-iconButtonGlyph)/2, Y: r.Y + (r.H-iconButtonGlyph)/2, W: iconButtonGlyph, H: iconButtonGlyph}, ink)
}
