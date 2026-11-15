package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	navItemPadY       = 8
	navItemPadX       = 9.6
	navItemGap        = 9.6
	navItemRadius     = 8
	navItemIcon       = 17
	navItemSize       = 14.08
	navItemLine       = navItemSize * 1.5
	navItemHoverAlpha = 0.06
	navItemOnAlpha    = 0.16
)

var navItemStyle = paint.TextStyle{Size: navItemSize, Weight: paint.Medium}

// NavItem is one entry of a menu down the side of a settings window: an icon and a label, lit while it is the page shown.
type NavItem struct {
	Icon     string
	Label    string
	Selected bool
	OnClick  func()
}

func (n NavItem) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: 2*(navItemPadY+c.Hairline()) + navItemLine}
}

func (n NavItem) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	ink := c.Theme.Muted
	switch {
	case n.Selected:
		c.Paint.Fill(r, navItemRadius, theme.WithAlpha(c.Theme.Accent, navItemOnAlpha))
		ink = c.Theme.Accent
	case hovered:
		c.Paint.Fill(r, navItemRadius, theme.WithAlpha(c.Theme.Tint, navItemHoverAlpha))
		ink = c.Theme.Text
	}
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if c.Clicked(r) {
		c.Claim()
		if n.OnClick != nil {
			n.OnClick()
		}
	}
	x := r.X + c.Hairline() + navItemPadX
	mid := r.Y + r.H/2
	c.Paint.Icon(n.Icon, geom.Rect{X: x, Y: mid - navItemIcon/2, W: navItemIcon, H: navItemIcon}, ink)
	c.Paint.Text(n.Label, x+navItemIcon+navItemGap, mid-navItemLine/2, navItemLine, navItemStyle, ink)
}
