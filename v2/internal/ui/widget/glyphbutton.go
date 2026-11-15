package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	glyphRadius   = 6
	glyphDisabled = 0.35
	glyphFaint    = 0.6
	glyphPadX     = 6.4
	glyphPadY     = 4.8
	glyphIcon     = 19.2
)

// GlyphButton is a bare icon that gets a faint plate under the pointer: the controls on the voice panel and the self strip.
type GlyphButton struct {
	Icon     string
	Size     float32
	PadX     float32
	PadY     float32
	Danger   bool
	On       bool
	Disabled bool
	Inert    bool
	Faint    bool
	OnClick  func()
}

func (g GlyphButton) metrics() (size, padX, padY float32) {
	size, padX, padY = g.Size, g.PadX, g.PadY
	if size == 0 {
		size, padX, padY = glyphIcon, glyphPadX, glyphPadY
	}
	return size, padX, padY
}

func (g GlyphButton) Measure(*Context, float32) geom.Size {
	size, padX, padY := g.metrics()
	return geom.Size{W: size + 2*padX, H: size + 2*padY}
}

func (g GlyphButton) Draw(c *Context, r geom.Rect) {
	size, padX, padY := g.metrics()
	hovered := !g.Disabled && !g.Inert && c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, glyphRadius, c.Theme.Border)
	}
	ink := c.Theme.Text
	if g.Danger || g.On {
		ink = c.Theme.DangerSoft
	}
	switch {
	case g.Disabled:
		ink = theme.WithAlpha(ink, glyphDisabled)
	case g.Faint && !hovered:
		ink = theme.WithAlpha(ink, glyphFaint)
	}
	g.drawIcon(c, geom.Rect{X: r.X + padX, Y: r.Y + padY, W: size, H: size}, ink)
	if hovered && c.Clicked(r) {
		c.Claim()
		if g.OnClick != nil {
			g.OnClick()
		}
	}
}

func (g GlyphButton) drawIcon(c *Context, r geom.Rect, ink color.RGBA) { c.Paint.Icon(g.Icon, r, ink) }
