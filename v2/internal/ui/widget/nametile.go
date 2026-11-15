package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	nameTileHeight = 44.8
	nameTileSize   = 16.8
	nameTileRadius = 8
	nameTileFill   = 0.04
	nameTileHover  = 0.09
	nameTileOn     = 0.16
	nameTileEdge   = 0.14
)

// NameTile is one choice among names drawn in different looks: a label in its own font or colour, lit when chosen.
type NameTile struct {
	Label   string
	Look    *people.Style
	On      bool
	OnClick func()
}

func (NameTile) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: nameTileHeight}
}

func (t NameTile) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	fill, edge := theme.WithAlpha(c.Theme.Tint, nameTileFill), theme.WithAlpha(c.Theme.Tint, nameTileEdge)
	switch {
	case t.On:
		fill, edge = theme.WithAlpha(c.Theme.Accent, nameTileOn), c.Theme.Accent
	case hovered:
		fill = theme.WithAlpha(c.Theme.Tint, nameTileHover)
	}
	c.Paint.Fill(r, nameTileRadius, fill)
	c.Paint.Stroke(r, nameTileRadius, c.Hairline(), edge)
	style := paint.TextStyle{Size: nameTileSize, Weight: paint.Medium}
	line := float32(nameTileSize * 1.5)
	w := c.NameWidth(t.Label, t.Look, style)
	inner := r.InsetAll(c.Hairline() + nameTileRadius/2)
	if w > inner.W {
		c.Paint.PushClip(inner)
		defer c.Paint.PopClip()
	}
	c.DrawName(t.Label, t.Look, max(inner.X, r.X+(r.W-w)/2), r.Y+(r.H-line)/2, line, style, c.Theme.Text)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			if t.OnClick != nil {
				t.OnClick()
			}
		}
	}
}
