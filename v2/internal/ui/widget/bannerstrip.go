package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

// DrawBannerStrip draws somebody's banner behind a row, dimmed as its owner chose and fading out toward the left; the corners
// are rounded off in the colour the row sits on. It says whether there was a banner to draw.
func (c *Context) DrawBannerStrip(hash string, dim *int, r geom.Rect, radius float32, behind color.RGBA) bool {
	if hash == "" || c.Faces == nil {
		return false
	}
	brightness, opacity := BannerLook(dim)
	pic := c.Paint.Sized(paint.Cover, hash, c.Paint.PixelSize(r.W), c.Paint.PixelSize(r.H), c.Faces)
	if !c.Paint.DrawFaded(pic, r, brightness, opacity) {
		return false
	}
	if radius > 0 {
		c.Paint.Corners(r, radius, behind)
	}
	return true
}
