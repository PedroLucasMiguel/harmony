package paint

import "math"

type placedGlyph struct {
	bitmap *bitmap
	dx, dy float32
}

// placement is where each glyph of a run lands relative to its origin, in device pixels, for one scale.
type placement struct {
	glyphs []placedGlyph
	scale  float32
}

func (p *Painter) place(r *run, size, scale float32) {
	r.place.glyphs = r.place.glyphs[:0]
	for _, g := range r.glyphs {
		b := p.atlas.lookup(r.face, g.id, size*scale)
		if b.page < 0 {
			continue
		}
		r.place.glyphs = append(r.place.glyphs, placedGlyph{b, float32(math.Round(float64(g.x*scale))) + b.left, g.y*scale + b.top})
	}
	r.place.scale = scale
}
