package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	plateRadius = 8
	plateIcon   = 18
	tinyFade    = 0.25
)

// PlateButton is a button with one icon, as big as the rectangle it is given: the transport buttons of a player.
// A Primary one is on the accent; a Ghost one is on the raised surface, and its icon is in the accent while On.
type PlateButton struct {
	Icon     string
	Variant  Variant
	On       bool
	Disabled bool
	// Faint is the disabled look of a button in a row of small tools: fainter than a form button's.
	Faint   bool
	OnClick func()
}

func (b *PlateButton) Draw(c *Context, r geom.Rect) {
	hovered := !b.Disabled && c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	fill, edge, ink := c.Theme.Surface2, c.Theme.Border, c.Theme.Text
	switch {
	case b.Variant == Primary:
		fill, edge, ink = c.Theme.Accent, theme.WithAlpha(c.Theme.Accent, 0), ToneOnAccent.Color(c.Theme)
		if hovered {
			fill = c.Theme.AccentHover
		}
	case b.On:
		ink = c.Theme.Accent
	}
	if b.Disabled {
		alpha := float32(disabledOpacity)
		if b.Faint {
			alpha = tinyFade
		}
		fill, edge, ink = fade(fill, true), fade(edge, true), theme.WithAlpha(ink, alpha)
		if b.Faint {
			fill, edge = theme.WithAlpha(c.Theme.Surface2, tinyFade), theme.WithAlpha(c.Theme.Border, tinyFade)
		}
	}
	c.Paint.Fill(r, plateRadius, fill)
	if edge.A > 0 {
		c.Paint.Stroke(r, plateRadius, c.Hairline(), edge)
	}
	c.Paint.Icon(b.Icon, geom.Rect{X: r.X + (r.W-plateIcon)/2, Y: r.Y + (r.H-plateIcon)/2, W: plateIcon, H: plateIcon}, ink)
	if hovered && c.Clicked(r) {
		c.Claim()
		if b.OnClick != nil {
			b.OnClick()
		}
	}
}
