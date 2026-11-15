package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	coverRadius = 6
	coverFill   = 0.12
)

// Cover is a track's picture in a small rounded square, a faint plate while it has none; Under is what the square sits on.
type Cover struct {
	Hash   string
	Source paint.Source
	Size   float32
	Under  color.RGBA
}

func (v Cover) Measure(*Context, float32) geom.Size { return geom.Size{W: v.Size, H: v.Size} }

func (v Cover) Draw(c *Context, r geom.Rect) {
	r = geom.Rect{X: r.X, Y: r.Y, W: v.Size, H: v.Size}
	c.Paint.Fill(r, coverRadius, theme.WithAlpha(c.Theme.Tint, coverFill))
	if v.Hash == "" || v.Source == nil {
		return
	}
	if pic := c.Paint.PictureFrom(v.Hash, v.Source); pic.State() == paint.PictureReady {
		c.Paint.DrawPicture(pic, r, coverRadius, true, v.Under)
	}
}
