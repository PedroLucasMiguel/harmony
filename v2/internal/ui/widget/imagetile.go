package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	imageTileDash       = 3
	imageTileGhostAlpha = 0.08
)

// ImageTile shows a picture of a fixed size in a rounded frame. With no picture it shows the server badge for Name, or, with no
// name, an empty dashed frame.
type ImageTile struct {
	Picture *paint.Picture
	Name    string
	Size    geom.Size
	Radius  float32
}

func (t ImageTile) Measure(*Context, float32) geom.Size { return t.Size }

func (t ImageTile) Draw(c *Context, r geom.Rect) {
	r = geom.Rect{X: r.X, Y: r.Y, W: t.Size.W, H: t.Size.H}
	if t.Picture != nil && t.Picture.State() == paint.PictureReady {
		c.Paint.DrawPicture(t.Picture, r, t.Radius, true, c.Theme.Surface2)
		return
	}
	if t.Name != "" {
		ServerBadge(c, r, t.Name)
		return
	}
	c.Paint.Fill(r, t.Radius, theme.WithAlpha(c.Theme.Tint, imageTileGhostAlpha))
	c.Paint.DashedRoundRect(r, t.Radius, c.Hairline(), imageTileDash, imageTileDash, c.Theme.BorderStrong)
}
