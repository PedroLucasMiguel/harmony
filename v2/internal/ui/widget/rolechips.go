package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	roleChipSize   = 11.52
	roleChipPadX   = 5.76
	roleChipDot    = 8.06
	roleChipDotGap = 3.46
	roleChipGap    = 4
	roleChipLine   = roleChipSize * 1.5
)

var roleChipStyle = paint.TextStyle{Size: roleChipSize, Weight: paint.Regular}

// RoleChip is a role's name in a pill, with its colour as a dot before it.
type RoleChip struct {
	Name  string
	Color color.RGBA
}

// dot is the room taken by the colour dot: a chip with no colour (a transparent one) is only its name.
func (r RoleChip) dot() float32 {
	if r.Color.A == 0 {
		return 0
	}
	return roleChipDot + roleChipDotGap
}

func (r RoleChip) width(c *Context) float32 {
	return 2*(roleChipPadX+c.Hairline()) + r.dot() + c.Paint.TextWidth(r.Name, roleChipStyle)
}

func (r RoleChip) height(c *Context) float32 { return roleChipLine + 2*c.Hairline() }

func (r RoleChip) draw(c *Context, x, y float32) {
	b := geom.Rect{X: x, Y: y, W: r.width(c), H: r.height(c)}
	c.Paint.Stroke(b, b.H/2, c.Hairline(), c.Theme.Border)
	inner := b.InsetAll(c.Hairline())
	if r.Color.A != 0 {
		c.Paint.Fill(geom.Rect{X: inner.X + roleChipPadX, Y: inner.Y + (inner.H-roleChipDot)/2, W: roleChipDot, H: roleChipDot}, roleChipDot/2, r.Color)
	}
	c.Paint.Text(r.Name, inner.X+roleChipPadX+r.dot(), inner.Y, roleChipLine, roleChipStyle, c.Theme.Muted)
}

// RoleChips is a row of chips, those that fit in the room there is and no more.
type RoleChips struct {
	Chips []RoleChip
	// Share is the most of the width it is given that it may take, from 0 to 1; zero is all of it.
	Share float32
}

func (r RoleChips) Measure(c *Context, maxWidth float32) geom.Size {
	if r.Share > 0 {
		maxWidth *= r.Share
	}
	width, height := float32(0), float32(0)
	for _, chip := range r.Chips {
		w := chip.width(c)
		if width+w > maxWidth {
			break
		}
		width += w + roleChipGap
		height = chip.height(c)
	}
	return geom.Size{W: max(width-roleChipGap, 0), H: height}
}

func (r RoleChips) Draw(c *Context, b geom.Rect) {
	x := b.X
	for _, chip := range r.Chips {
		w := chip.width(c)
		if x+w > b.Right()+0.01 {
			break
		}
		chip.draw(c, x, b.Y+(b.H-chip.height(c))/2)
		x += w + roleChipGap
	}
}
