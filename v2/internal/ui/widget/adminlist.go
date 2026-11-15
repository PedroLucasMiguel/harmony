package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	adminListPad    = 3.2
	adminListRadius = 8
	adminRowPadY    = 5.6
	adminRowPadX    = 8
	adminRowGap     = 8
	adminRowRadius  = 6
	adminRowLine    = 21
	adminRowHover   = 0.06
	adminRowOn      = 0.16
	adminEmptyPadY  = 9.6
	adminEmptyPadX  = 11.2
	adminEmptySize  = 13.6
)

// AdminRow is one line of an AdminList: what leads, the name that takes the room left, and what trails, which keeps its own size.
type AdminRow struct {
	Lead     Component
	Name     Component
	Trail    []Component
	Selected bool
	// Indent replaces the left padding, to set a row in under its heading.
	Indent  float32
	OnClick func()
}

func (r *AdminRow) height(c *Context, width float32) float32 {
	h := float32(adminRowLine)
	if r.Lead != nil {
		h = max(h, r.Lead.Measure(c, width).H)
	}
	if r.Name != nil {
		h = max(h, r.Name.Measure(c, width).H)
	}
	for _, t := range r.Trail {
		h = max(h, t.Measure(c, width).H)
	}
	return h + 2*adminRowPadY
}

func (r *AdminRow) draw(c *Context, b geom.Rect) {
	hovered := c.Hovered(b)
	switch {
	case r.Selected:
		c.Paint.Fill(b, adminRowRadius, theme.WithAlpha(c.Theme.Accent, adminRowOn))
	case hovered:
		c.Paint.Fill(b, adminRowRadius, theme.WithAlpha(c.Theme.Tint, adminRowHover))
	}
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(b) && r.OnClick != nil {
			c.Claim()
			r.OnClick()
		}
	}
	left := b.X + adminRowPadX
	if r.Indent > 0 {
		left = b.X + r.Indent
	}
	right := b.Right() - adminRowPadX
	centred := func(comp Component, x, width float32, fromRight bool) geom.Size {
		size := comp.Measure(c, width)
		size.W = min(size.W, width)
		if fromRight {
			x -= size.W
		}
		comp.Draw(c, geom.Rect{X: x, Y: b.Y + (b.H-size.H)/2, W: size.W, H: size.H})
		return size
	}
	if r.Lead != nil {
		left += centred(r.Lead, left, right-left, false).W + adminRowGap
	}
	for i := len(r.Trail) - 1; i >= 0; i-- {
		right -= centred(r.Trail[i], right, right-left, true).W + adminRowGap
	}
	if r.Name != nil && right > left {
		size := r.Name.Measure(c, right-left)
		c.Paint.PushClip(geom.Rect{X: left, Y: b.Y, W: right - left, H: b.H})
		r.Name.Draw(c, geom.Rect{X: left, Y: b.Y + (b.H-size.H)/2, W: right - left, H: size.H})
		c.Paint.PopClip()
	}
}

// AdminList is the bordered list at the left of a page of the Server dialog; it scrolls inside the height it is given. Keep the same
// AdminList between builds so that its scroll stays where it was.
type AdminList struct {
	Rows []AdminRow
	// Empty is what to say when the list has no rows; with no Empty either, the list is not drawn.
	Empty  string
	Scroll Scroll
	rows   adminRows
}

func (l *AdminList) frame(c *Context) float32 { return 2 * (adminListPad + c.Hairline()) }

func (l *AdminList) natural(c *Context, width float32) float32 {
	inner := width - l.frame(c)
	h := float32(0)
	for i := range l.Rows {
		h += l.Rows[i].height(c, inner)
	}
	if len(l.Rows) == 0 {
		if l.Empty == "" {
			return 0
		}
		h = adminEmptyLine() + 2*adminEmptyPadY
	}
	return h + l.frame(c)
}

func adminEmptyLine() float32 { return adminEmptySize * 1.5 }

func (l *AdminList) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: l.natural(c, maxWidth)}
}

func (l *AdminList) Draw(c *Context, r geom.Rect) {
	if r.H <= 0 {
		return
	}
	c.Paint.Fill(r, adminListRadius, c.Theme.Surface)
	c.Paint.Stroke(r, adminListRadius, c.Hairline(), c.Theme.Border)
	view := r.InsetAll(adminListPad + c.Hairline())
	l.rows = adminRows{l, view}
	l.Scroll.Child = &l.rows
	l.Scroll.Bar = true
	l.Scroll.Draw(c, view)
}

type adminRows struct {
	l    *AdminList
	view geom.Rect
}

func (a *adminRows) Measure(c *Context, maxWidth float32) geom.Size {
	h := float32(0)
	for i := range a.l.Rows {
		h += a.l.Rows[i].height(c, maxWidth)
	}
	if len(a.l.Rows) == 0 {
		h = adminEmptyLine() + 2*adminEmptyPadY
	}
	return geom.Size{W: maxWidth, H: h}
}

func (a *adminRows) Draw(c *Context, r geom.Rect) {
	if len(a.l.Rows) == 0 {
		c.Paint.Text(a.l.Empty, r.X+adminEmptyPadX, r.Y+adminEmptyPadY, adminEmptyLine(), paint.TextStyle{Size: adminEmptySize, Weight: paint.Regular}, c.Theme.Muted)
		return
	}
	y := r.Y
	for i := range a.l.Rows {
		h := a.l.Rows[i].height(c, r.W)
		if y+h >= a.view.Y && y <= a.view.Bottom() {
			a.l.Rows[i].draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		}
		y += h
	}
}
