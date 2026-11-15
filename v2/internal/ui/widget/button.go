package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

type Variant int

const (
	Primary Variant = iota
	Ghost
	Link
)

const (
	buttonRadius      = 8
	disabledOpacity   = 0.45
	iconButtonGlyphPx = 18
)

type Button struct {
	Label    string
	Icon     string
	Variant  Variant
	Small    bool
	Size     float32
	Disabled bool
	// Active shows a toggle that is on, in the accent colour.
	Active bool
	// Danger sets a ghost button's label in the warning colour, for what removes something.
	Danger bool
	// IconSize is the room the icon takes, and IconGap the space between it and the label; zero keeps the usual.
	IconSize float32
	IconGap  float32
	Opacity  float32
	OnClick  func()
}

func (b *Button) style() paint.TextStyle {
	if b.Size > 0 {
		return paint.TextStyle{Size: b.Size, Weight: paint.Regular}
	}
	if b.Small {
		return paint.TextStyle{Size: 13, Weight: paint.Medium}
	}
	return paint.TextStyle{Size: 14, Weight: paint.Medium}
}

func (b *Button) padding() (vertical, horizontal float32) {
	switch {
	case b.Variant == Link:
		return 0, 0
	case b.Small:
		return 6, 12
	}
	return 9, 16
}

func (b *Button) iconBox() float32 {
	if b.IconSize > 0 {
		return b.IconSize
	}
	return iconButtonGlyphPx
}

func (b *Button) content(c *Context) geom.Size {
	st := b.style()
	size := geom.Size{}
	if b.Icon != "" {
		size = geom.Size{W: b.iconBox(), H: iconButtonGlyphPx}
		if b.Label != "" {
			size.W += b.IconGap
		}
	}
	if b.Label != "" {
		size.W += c.Paint.TextWidth(b.Label, st)
		size.H = max(size.H, st.Size*1.5)
	}
	return size
}

func (b *Button) Measure(c *Context, maxWidth float32) geom.Size {
	v, h := b.padding()
	border := float32(0)
	if b.Variant != Link {
		border = 2 * c.Hairline()
	}
	content := b.content(c)
	return geom.Size{W: content.W + 2*h + border, H: content.H + 2*v + border}
}

func (b *Button) Draw(c *Context, r geom.Rect) {
	hovered := !b.Disabled && c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if b.Disabled {
		c.SetCursor(rl.MouseCursorNotAllowed)
	}
	fill, border, ink := b.colors(c.Theme, hovered)
	if b.Variant != Link {
		c.Paint.Fill(r, buttonRadius, fade(fill, b.Disabled))
		if border.A > 0 {
			c.Paint.Stroke(r, buttonRadius, c.Hairline(), fade(border, b.Disabled))
		}
	}
	b.drawContent(c, r, withOpacity(fade(ink, b.Disabled), b.Opacity), hovered)
	if !b.Disabled && c.Clicked(r) {
		c.Claim()
		if b.OnClick != nil {
			b.OnClick()
		}
	}
}

func (b *Button) colors(p theme.Palette, hovered bool) (fill, border, ink color.RGBA) {
	switch b.Variant {
	case Primary:
		fill = p.Accent
		if hovered {
			fill = p.AccentHover
		}
		return fill, color.RGBA{}, ToneOnAccent.Color(p)
	case Ghost:
		ink = p.Text
		if b.Active {
			ink = p.Accent
		}
		if b.Danger {
			ink = p.DangerSoft
		}
		return p.Surface2, p.Border, ink
	}
	ink = p.Accent
	if hovered {
		ink = theme.Brighten(p.Accent, 1.2)
	}
	return color.RGBA{}, color.RGBA{}, ink
}

func (b *Button) drawContent(c *Context, r geom.Rect, ink color.RGBA, hovered bool) {
	st := b.style()
	content := b.content(c)
	x := r.X + (r.W-content.W)/2
	if b.Variant == Link {
		x = r.X
	}
	if b.Icon != "" {
		box := b.iconBox()
		c.Paint.Icon(b.Icon, geom.Rect{X: x, Y: r.Y + (r.H-box)/2, W: box, H: box}, ink)
		x += box + b.IconGap
	}
	if b.Label == "" {
		return
	}
	line := st.Size * 1.5
	top := r.Y + (r.H-line)/2
	c.Paint.Text(b.Label, x, top, line, st, ink)
	if b.Variant == Link {
		underline := top + line/2 + c.Paint.ContentHeight(st)/2 - 1
		c.Paint.Line(x, underline, x+content.W, underline, c.Hairline(), ink)
	}
}

func fade(c color.RGBA, disabled bool) color.RGBA {
	if !disabled {
		return c
	}
	return theme.WithAlpha(c, float32(c.A)/255*disabledOpacity)
}
