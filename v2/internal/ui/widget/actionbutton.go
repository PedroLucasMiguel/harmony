package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	actionPadY     = 8
	actionRadius   = 8
	actionIcon     = 18.4
	actionLine     = 1.2
	actionOnFill   = 0.22
	actionOnBorder = 0.5
	actionDisabled = 0.45
)

// ActionButton is a plate with one icon, a third of the voice panel wide.
type ActionButton struct {
	Icon     string
	On       bool
	Disabled bool
	// Inert looks like any other button and does nothing: its feature is not in this client yet.
	Inert   bool
	OnClick func()
}

func (a ActionButton) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: 2*actionPadY + actionIcon*actionLine + 2*c.Hairline()}
}

func (a ActionButton) Draw(c *Context, r geom.Rect) {
	hovered := !a.Disabled && !a.Inert && c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	fill, edge := c.Theme.Surface2, c.Theme.Border
	switch {
	case a.On:
		fill, edge = theme.WithAlpha(c.Theme.Accent, actionOnFill), theme.WithAlpha(c.Theme.Accent, actionOnBorder)
	case hovered:
		fill = c.Theme.Border
	}
	ink := c.Theme.Text
	if a.Disabled {
		fill, edge, ink = theme.WithAlpha(fill, actionDisabled), theme.WithAlpha(edge, actionDisabled), theme.WithAlpha(ink, actionDisabled)
	}
	c.Paint.Fill(r, actionRadius, fill)
	c.Paint.Stroke(r, actionRadius, c.Hairline(), edge)
	c.Paint.Icon(a.Icon, geom.Rect{X: r.X + (r.W-actionIcon)/2, Y: r.Y + (r.H-actionIcon)/2, W: actionIcon, H: actionIcon}, ink)
	if hovered && c.Clicked(r) {
		c.Claim()
		if a.OnClick != nil {
			a.OnClick()
		}
	}
}
