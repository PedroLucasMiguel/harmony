package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const serverTileTint = 0.22

// ServerLogo is a server's picture: the hash it is kept under and the store that fetches it from that server.
type ServerLogo struct {
	Hash string
	Src  paint.Sizer
}

// DrawServerLogo draws a server's logo over r, its corners rounded to radius in the colour behind it, and says whether there was
// one to draw (it is only drawn once it has loaded).
func (c *Context) DrawServerLogo(l ServerLogo, r geom.Rect, radius float32, behind color.RGBA) bool {
	return c.DrawServerLogoAlpha(l, r, radius, behind, 1)
}

// DrawServerLogoAlpha is DrawServerLogo faded to alpha, for a server that cannot be reached.
func (c *Context) DrawServerLogoAlpha(l ServerLogo, r geom.Rect, radius float32, behind color.RGBA, alpha float32) bool {
	if l.Hash == "" || l.Src == nil {
		return false
	}
	pic := c.Paint.Sized(paint.Cover, l.Hash, c.Paint.PixelSize(r.W), c.Paint.PixelSize(r.H), l.Src)
	if !c.Paint.DrawSized(pic, r, alpha) {
		return false
	}
	if radius > 0 {
		c.Paint.Corners(r, radius, behind)
	}
	return true
}

// ServerTile is a server's face: its logo, or its initial on a tint of the accent when it has none.
func (c *Context) ServerTile(r geom.Rect, name string, l ServerLogo, radius, textSize float32, behind color.RGBA) {
	if c.DrawServerLogo(l, r, radius, behind) {
		return
	}
	c.Paint.Fill(r, radius, theme.WithAlpha(c.Theme.Accent, serverTileTint))
	style := paint.TextStyle{Size: textSize, Weight: paint.Bold}
	initial := initialM.of(name)
	width := c.Paint.TextWidth(initial, style)
	line := textSize * 1.5
	c.Paint.Text(initial, r.X+(r.W-width)/2, r.Y+(r.H-line)/2, line, style, c.Theme.Text)
}
