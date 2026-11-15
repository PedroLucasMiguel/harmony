package imagecrop

import (
	"image"
	"image/draw"
	"image/gif"
)

// canvas composes the frames of a GIF the way a viewer does, so that each one is the whole picture.
type canvas struct {
	g     *gif.GIF
	img   *image.RGBA
	saved *image.RGBA
	last  int
}

func newCanvas(g *gif.GIF) *canvas {
	w, h := g.Config.Width, g.Config.Height
	if w == 0 || h == 0 {
		b := g.Image[0].Bounds()
		w, h = b.Max.X, b.Max.Y
	}
	return &canvas{g: g, img: image.NewRGBA(image.Rect(0, 0, w, h)), last: -1}
}

// show puts frame i on the canvas; frames must be asked for in order.
func (c *canvas) show(i int) {
	if c.last >= 0 {
		prev := c.g.Image[c.last]
		switch c.disposal(c.last) {
		case gif.DisposalBackground:
			draw.Draw(c.img, prev.Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			if c.saved != nil {
				draw.Draw(c.img, c.img.Bounds(), c.saved, image.Point{}, draw.Src)
			}
		}
	}
	if c.disposal(i) == gif.DisposalPrevious {
		if c.saved == nil {
			c.saved = image.NewRGBA(c.img.Bounds())
		}
		draw.Draw(c.saved, c.saved.Bounds(), c.img, image.Point{}, draw.Src)
	}
	f := c.g.Image[i]
	draw.Draw(c.img, f.Bounds(), f, f.Bounds().Min, draw.Over)
	c.last = i
}

func (c *canvas) disposal(i int) byte {
	if i < len(c.g.Disposal) {
		return c.g.Disposal[i]
	}
	return 0
}
