package paint

import (
	"image/color"
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"
)

// The shapes below tessellate exactly as raylib's own rshapes.c does (same triangles, same winding), so pixels stay as they were.

const (
	corner       = cornerSegments
	circleSteps  = 36
	whiteCoord   = 1.0 / atlasSize
	degreesToRad = math.Pi / 180
)

type point struct{ x, y float32 }

// cornerRim holds, for each of the four corners in the order raylib draws them, the unit vectors along its quarter circle.
var cornerRim = func() (rim [4][corner + 1]point) {
	for k, start := range [4]float64{180, 270, 0, 90} {
		for i := range rim[k] {
			a := (start + float64(i)*90/corner) * degreesToRad
			rim[k][i] = point{float32(math.Cos(a)), float32(math.Sin(a))}
		}
	}
	return rim
}()

var circleRim = func() (rim [circleSteps]point) {
	for i := range rim {
		a := float64(i) * 360 / circleSteps * degreesToRad
		rim[i] = point{float32(math.Cos(a)), float32(math.Sin(a))}
	}
	return rim
}()

// solid reserves geometry drawn in one flat colour: it samples the white block of an atlas page, so it shares a draw call with the text around it.
func (p *Painter) solid(nv, ni int) ([]vertex, []uint16, uint16) {
	return p.b.reserve(p.atlas.solidTexture(p.b.current()), nv, ni)
}

func fillVertices(v []vertex, c color.RGBA) {
	for i := range v {
		v[i].u, v[i].v, v[i].c = whiteCoord, whiteCoord, c
	}
}

func (p *Painter) solidQuad(x0, y0, x1, y1 float32, c color.RGBA) {
	v, ix, base := p.solid(4, 6)
	fillVertices(v, c)
	v[0].x, v[0].y = x0, y0
	v[1].x, v[1].y = x0, y1
	v[2].x, v[2].y = x1, y1
	v[3].x, v[3].y = x1, y0
	quadIndices(ix, base)
}

func quadIndices(ix []uint16, base uint16) {
	ix[0], ix[1], ix[2], ix[3], ix[4], ix[5] = base, base+1, base+2, base, base+2, base+3
}

func (p *Painter) solidTriangle(a, b, c point, col color.RGBA) {
	v, ix, base := p.solid(3, 3)
	fillVertices(v, col)
	v[0].x, v[0].y = a.x, a.y
	v[1].x, v[1].y = b.x, b.y
	v[2].x, v[2].y = c.x, c.y
	ix[0], ix[1], ix[2] = base, base+1, base+2
}

func (p *Painter) solidLine(a, b point, thick float32, c color.RGBA) {
	dx, dy := b.x-a.x, b.y-a.y
	length := float32(math.Sqrt(float64(dx*dx + dy*dy)))
	if length <= 0 || thick <= 0 {
		return
	}
	scale := thick / (2 * length)
	rx, ry := -scale*dy, scale*dx
	v, ix, base := p.solid(4, 6)
	fillVertices(v, c)
	v[0].x, v[0].y = a.x-rx, a.y-ry
	v[1].x, v[1].y = a.x+rx, a.y+ry
	v[2].x, v[2].y = b.x-rx, b.y-ry
	v[3].x, v[3].y = b.x+rx, b.y+ry
	ix[0], ix[1], ix[2], ix[3], ix[4], ix[5] = base+2, base, base+1, base+3, base+2, base+1
}

func (p *Painter) solidCircle(cx, cy, radius float32, c color.RGBA) {
	if radius <= 0 {
		return
	}
	v, ix, base := p.solid(1+circleSteps, 3*circleSteps)
	fillVertices(v, c)
	v[0].x, v[0].y = cx, cy
	for i, u := range circleRim {
		v[1+i].x, v[1+i].y = cx+u.x*radius, cy+u.y*radius
		next := (i + 1) % circleSteps
		ix[3*i], ix[3*i+1], ix[3*i+2] = base, base+1+uint16(next), base+1+uint16(i)
	}
}

// solidRect fills a rectangle with square corners.
func (p *Painter) solidRect(x, y, w, h float32, c color.RGBA) { p.solidQuad(x, y, x+w, y+h, c) }

func (p *Painter) solidRectLines(x, y, w, h, thick float32, c color.RGBA) {
	if thick > w/2 || thick > h/2 {
		if w >= h {
			thick = h / 2
		} else {
			thick = w / 2
		}
	}
	if thick <= 0 {
		return
	}
	p.solidRect(x, y, w, thick, c)
	p.solidRect(x, y-thick+h, w, thick, c)
	p.solidRect(x, y+thick, thick, h-thick*2, c)
	p.solidRect(x-thick+w, y+thick, thick, h-thick*2, c)
}

// roundedPoints are the twelve points raylib's rounded rectangle is built from.
func roundedPoints(x, y, w, h, radius float32) (pts [12]point, centers [4]point) {
	x0, x1, x2, x3 := x+radius, (x+w)-radius, x+w, x
	y0, y1, y2, y3 := y, y+radius, (y+h)-radius, y+h
	pts = [12]point{{x0, y0}, {x1, y0}, {x2, y1}, {x2, y2}, {x1, y3}, {x0, y3}, {x3, y2}, {x3, y1}, {x0, y1}, {x1, y1}, {x1, y2}, {x0, y2}}
	return pts, [4]point{pts[8], pts[9], pts[10], pts[11]}
}

func (p *Painter) solidRounded(x, y, w, h, roundness float32, c color.RGBA) {
	if roundness <= 0 {
		p.solidRect(x, y, w, h, c)
		return
	}
	roundness = min(roundness, 1)
	var radius float32
	if w > h {
		radius = h * roundness / 2
	} else {
		radius = w * roundness / 2
	}
	if radius <= 0 {
		return
	}
	pts, centers := roundedPoints(x, y, w, h, radius)
	const fan = 1 + corner + 1
	v, ix, base := p.solid(4*fan+12, 4*3*corner+5*6)
	fillVertices(v, c)
	n := 0
	for k := 0; k < 4; k++ {
		first := k * fan
		v[first].x, v[first].y = centers[k].x, centers[k].y
		for i, u := range cornerRim[k] {
			v[first+1+i].x, v[first+1+i].y = centers[k].x+u.x*radius, centers[k].y+u.y*radius
		}
		for i := 0; i < corner; i++ {
			ix[n], ix[n+1], ix[n+2] = base+uint16(first), base+uint16(first+2+i), base+uint16(first+1+i)
			n += 3
		}
	}
	shared := 4 * fan
	for i, pt := range pts {
		v[shared+i].x, v[shared+i].y = pt.x, pt.y
	}
	for _, q := range [5][4]int{{0, 8, 9, 1}, {2, 9, 10, 3}, {11, 5, 4, 10}, {7, 6, 11, 8}, {8, 11, 10, 9}} {
		a, b, cc, d := base+uint16(shared+q[0]), base+uint16(shared+q[1]), base+uint16(shared+q[2]), base+uint16(shared+q[3])
		ix[n], ix[n+1], ix[n+2], ix[n+3], ix[n+4], ix[n+5] = a, b, cc, a, cc, d
		n += 6
	}
}

func (p *Painter) solidRoundedLines(x, y, w, h, roundness, thick float32, c color.RGBA) {
	if roundness <= 0 {
		p.solidRectLines(x, y, w, h, thick, c)
		return
	}
	if thick <= 0 {
		return
	}
	roundness = min(roundness, 1)
	var radius float32
	if w > h {
		radius = h * roundness / 2
	} else {
		radius = w * roundness / 2
	}
	if radius <= 0 {
		return
	}
	outer, inner := radius, radius-thick
	var rimThick float32
	if inner <= 0 {
		inner, rimThick = 0, outer
		p.solidRectLines(x+outer, y+outer, w-outer*2, h-outer*2, thick-outer, c)
	} else {
		rimThick = thick
	}
	x0, x1, x2, x3, x4, x5 := x+outer, (x+w)-outer, x+w, x, (x+w)-rimThick, x+rimThick
	y0, y1, y2, y3, y4, y5 := y, y+outer, (y+h)-outer, y+h, y+rimThick, (y+h)-rimThick
	pts := [16]point{{x0, y0}, {x1, y0}, {x2, y1}, {x2, y2}, {x1, y3}, {x0, y3}, {x3, y2}, {x3, y1}, {x0, y4}, {x1, y4}, {x4, y1}, {x4, y2}, {x1, y5}, {x0, y5}, {x5, y2}, {x5, y1}}
	centers := [4]point{{x0, y1}, {x1, y1}, {x1, y2}, {x0, y2}}
	const ring = 2 * (corner + 1)
	v, ix, base := p.solid(4*ring+16, 4*6*corner+4*6)
	fillVertices(v, c)
	n := 0
	for k := 0; k < 4; k++ {
		first := k * ring
		for i, u := range cornerRim[k] {
			v[first+2*i].x, v[first+2*i].y = centers[k].x+u.x*inner, centers[k].y+u.y*inner
			v[first+2*i+1].x, v[first+2*i+1].y = centers[k].x+u.x*outer, centers[k].y+u.y*outer
		}
		for i := 0; i < corner; i++ {
			a, b := base+uint16(first+2*i), base+uint16(first+2*i+2)
			ix[n], ix[n+1], ix[n+2], ix[n+3], ix[n+4], ix[n+5] = a, b, b+1, a, b+1, a+1
			n += 6
		}
	}
	shared := 4 * ring
	for i, pt := range pts {
		v[shared+i].x, v[shared+i].y = pt.x, pt.y
	}
	for _, q := range [4][4]int{{0, 8, 9, 1}, {2, 10, 11, 3}, {13, 5, 4, 12}, {15, 7, 6, 14}} {
		a, b, cc, d := base+uint16(shared+q[0]), base+uint16(shared+q[1]), base+uint16(shared+q[2]), base+uint16(shared+q[3])
		ix[n], ix[n+1], ix[n+2], ix[n+3], ix[n+4], ix[n+5] = a, b, cc, a, cc, d
		n += 6
	}
}

// texturedQuad draws a rectangle of a texture, given by its u and v corners, over the destination, turned back to front when flipped.
func (p *Painter) texturedQuad(texture uint32, x0, y0, x1, y1, u0, v0, u1, v1 float32, flipped bool, c color.RGBA) {
	if flipped {
		u0, u1 = u1, u0
	}
	v, ix, base := p.b.reserve(texture, 4, 6)
	v[0] = vertex{x0, y0, u0, v0, c}
	v[1] = vertex{x0, y1, u0, v1, c}
	v[2] = vertex{x1, y1, u1, v1, c}
	v[3] = vertex{x1, y0, u1, v0, c}
	quadIndices(ix, base)
}

func (p *Painter) textureRect(texture uint32, r rl.Rectangle, u0, v0, u1, v1 float32, flipped bool, c color.RGBA) {
	p.texturedQuad(texture, r.X, r.Y, r.X+r.Width, r.Y+r.Height, u0, v0, u1, v1, flipped, c)
}
