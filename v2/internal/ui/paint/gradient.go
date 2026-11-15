package paint

import (
	"image/color"
	"math"
)

// GradientText draws text whose colour runs along ring, a closed loop of colours (its last equal to its first),
// spread over twice the text's width and slid along by phase (0 to 1 is one whole loop).
func (p *Painter) GradientText(s string, x, top, lineHeight float32, st TextStyle, ring []color.RGBA, phase float32) {
	baseline := top + (lineHeight-p.ContentHeight(st))/2 + p.Ascent(st)
	st = p.scaled(st)
	run := p.shaper.shape(s, st)
	scale := p.Zoom * p.dpi
	originX, originY := math.Round(float64(x*scale)), math.Round(float64(baseline*scale))
	if run.place.scale != scale {
		p.place(run, st.Size, scale)
	}
	ox, oy := float32(originX), float32(originY)
	span := 2 * max(run.width, 1) * scale
	for i := range run.place.glyphs {
		g := &run.place.glyphs[i]
		b := g.bitmap
		left := g.dx
		ul := left/span + phase
		ur := (left+b.w)/span + phase
		x0, y0 := (ox+g.dx)/p.dpi, (oy+g.dy)/p.dpi
		x1, y1 := x0+b.w/p.dpi, y0+b.h/p.dpi
		p.gradientQuad(b.texture, x0, y0, x1, y1, b.u0, b.v0, b.u1, b.v1, ringAt(ring, ul), ringAt(ring, ur))
	}
	p.drawEmoji(run, originX, originY, float64(st.Size), ring[0])
}

func (p *Painter) gradientQuad(texture uint32, x0, y0, x1, y1, u0, v0, u1, v1 float32, left, right color.RGBA) {
	v, ix, base := p.b.reserve(texture, 4, 6)
	v[0] = vertex{x0, y0, u0, v0, left}
	v[1] = vertex{x0, y1, u0, v1, left}
	v[2] = vertex{x1, y1, u1, v1, right}
	v[3] = vertex{x1, y0, u1, v0, right}
	quadIndices(ix, base)
}

// ringAt is the colour at u (any number, taken modulo 1) along a closed loop of evenly spaced colours.
func ringAt(ring []color.RGBA, u float32) color.RGBA {
	n := len(ring) - 1
	u -= float32(math.Floor(float64(u)))
	f := u * float32(n)
	i := int(f)
	if i >= n {
		return ring[n]
	}
	t := f - float32(i)
	a, b := ring[i], ring[i+1]
	return color.RGBA{lerp8(a.R, b.R, t), lerp8(a.G, b.G, t), lerp8(a.B, b.B, t), lerp8(a.A, b.A, t)}
}

func lerp8(a, b uint8, t float32) uint8 { return uint8(float32(a) + (float32(b)-float32(a))*t + 0.5) }
