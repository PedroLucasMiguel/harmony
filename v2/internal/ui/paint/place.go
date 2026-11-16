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
		whole, phase := splitPhase(g.x * scale)
		b := p.atlas.lookup(r.face, g.id, size*scale, phase)
		if b.page < 0 {
			continue
		}
		r.place.glyphs = append(r.place.glyphs, placedGlyph{b, whole + b.left, g.y*scale + b.top})
	}
	r.place.scale = scale
}

// splitPhase is a position in device pixels as the whole pixel it is in and the nearest of the places inside it.
func splitPhase(x float32) (whole float32, phase uint8) {
	whole = float32(math.Floor(float64(x)))
	phase = uint8(math.Round(float64(x-whole) * phases))
	if phase == phases {
		whole, phase = whole+1, 0
	}
	return whole, phase
}
