package paint

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
)

// Quad4 fills a rectangle with a colour at each corner, blended across it: the squares and bars of a colour picker.
func (p *Painter) Quad4(r geom.Rect, topLeft, topRight, bottomRight, bottomLeft color.RGBA) {
	rec := p.rect(r)
	v, ix, base := p.solid(4, 6)
	fillVertices(v, topLeft)
	v[0].x, v[0].y = rec.X, rec.Y
	v[1].x, v[1].y, v[1].c = rec.X, rec.Y+rec.Height, bottomLeft
	v[2].x, v[2].y, v[2].c = rec.X+rec.Width, rec.Y+rec.Height, bottomRight
	v[3].x, v[3].y, v[3].c = rec.X+rec.Width, rec.Y, topRight
	quadIndices(ix, base)
}
