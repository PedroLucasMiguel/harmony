package widget

import "harmony/v2/internal/ui/geom"

const roleIconSize = 17.6

// RoleIcon is the crown of the owner and the shield with a star of a super admin, in the palette's own colours.
type RoleIcon struct{ Owner bool }

func (RoleIcon) Measure(*Context, float32) geom.Size {
	return geom.Size{W: roleIconSize, H: roleIconSize}
}

func (i RoleIcon) Draw(c *Context, r geom.Rect) {
	name, ink := "shield-star", c.Theme.Accent
	if i.Owner {
		name, ink = "crown-simple", c.Theme.Warn
	}
	c.Paint.Icon(name, geom.Rect{X: r.X, Y: r.Y + (r.H-roleIconSize)/2, W: roleIconSize, H: roleIconSize}, ink)
}
