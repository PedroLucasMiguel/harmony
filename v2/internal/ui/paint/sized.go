package paint

import (
	"image"
	"image/color"

	"harmony/v2/internal/ui/geom"
)

// picKey names a picture in the cache: an image by its key, or a small face by its hash at one size in device pixels.
type picKey struct {
	key  string
	px   int32
	kind Shape
}

// Shape is how a sized picture is cut: Cover fills the box and crops the overflow, Round does that inside a circle.
type Shape uint8

const (
	Cover Shape = iota
	Round
)

// Sizer makes a picture's pixels already at the size it will be drawn.
type Sizer interface {
	Sized(shape Shape, key string, w, h int) func() (*image.NRGBA, error)
}

// Sized is the picture under key made by src at w by h device pixels. It costs a map lookup once loaded, and nothing is allocated.
func (p *Painter) Sized(shape Shape, key string, w, h int, src Sizer) *Picture {
	ps := p.pictures
	k := picKey{key, int32(w)<<16 | int32(h), shape}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if pic, ok := ps.items[k]; ok {
		return pic
	}
	pic := &Picture{}
	ps.items[k] = pic
	make := src.Sized(shape, key, w, h)
	go ps.load(pic, func() (*image.NRGBA, int, int, error) {
		img, err := make()
		if err != nil {
			return nil, 0, 0, err
		}
		return img, w, h, nil
	})
	return pic
}

// PixelSize is a size in CSS pixels as a whole number of device pixels.
func (p *Painter) PixelSize(css float32) int { return int(css*p.Zoom*p.dpi + 0.5) }

// DrawSized draws a picture made by Sized into r, faded to alpha; nothing is drawn until it is ready, and the result says whether it was.
func (p *Painter) DrawSized(pic *Picture, r geom.Rect, alpha float32) bool {
	return p.DrawSizedTint(pic, r, color.RGBA{255, 255, 255, uint8(alpha*255 + 0.5)})
}

// DrawSizedTint is DrawSized with the picture multiplied by a colour: a grey to darken it.
func (p *Painter) DrawSizedTint(pic *Picture, r geom.Rect, tint color.RGBA) bool {
	if pic.State() != PictureReady {
		return false
	}
	p.drawPicture(pic, r, 0, false, color.RGBA{}, tint)
	return true
}

// DrawQuad draws a picture over four corners given in CSS pixels, clockwise from the top left, so that it can be turned.
func (p *Painter) DrawQuad(pic *Picture, corners [4][2]float32, tint color.RGBA) {
	tex, live := p.texture(pic)
	if !live {
		return
	}
	v, ix, base := p.b.reserve(tex.ID, 4, 6)
	// The same winding as texturedQuad: top left, bottom left, bottom right, top right.
	order := [4]struct {
		corner int
		u, v   float32
	}{{0, 0, 0}, {3, 0, 1}, {2, 1, 1}, {1, 1, 0}}
	for i, o := range order {
		v[i] = vertex{p.px(corners[o.corner][0]), p.px(corners[o.corner][1]), o.u, o.v, tint}
	}
	quadIndices(ix, base)
}

const (
	fadeStart = 0.18
	fadeAt    = 0.15
)

// DrawFaded draws a picture the way a banner sits behind a row: darkened to brightness (0 to 255), at an opacity, and fading out
// toward the left edge so that it melts into what is under it.
func (p *Painter) DrawFaded(pic *Picture, r geom.Rect, brightness uint8, opacity float32) bool {
	if pic.State() != PictureReady {
		return false
	}
	tex, live := p.texture(pic)
	if !live {
		return false
	}
	alpha := func(k float32) color.RGBA {
		return color.RGBA{brightness, brightness, brightness, uint8(k*opacity*255 + 0.5)}
	}
	x := [3]float32{r.X, r.X + r.W*fadeStart, r.Right()}
	u := [3]float32{0, fadeStart, 1}
	a := [3]color.RGBA{alpha(0), alpha(fadeAt), alpha(1)}
	y0, y1 := p.px(r.Y), p.px(r.Bottom())
	v, ix, base := p.b.reserve(tex.ID, 6, 12)
	for i := range 3 {
		px := p.px(x[i])
		v[2*i] = vertex{px, y0, u[i], 0, a[i]}
		v[2*i+1] = vertex{px, y1, u[i], 1, a[i]}
	}
	for s := range 2 {
		b := base + uint16(2*s)
		q := ix[6*s : 6*s+6]
		q[0], q[1], q[2], q[3], q[4], q[5] = b, b+1, b+3, b, b+3, b+2
	}
	return true
}

// Visible is whether any of r is inside the clip in force: what is outside it need not be drawn.
func (p *Painter) Visible(r geom.Rect) bool {
	n := len(p.clips)
	if n == 0 {
		return true
	}
	c := p.clips[n-1]
	return r.X < c.Right() && r.Right() > c.X && r.Y < c.Bottom() && r.Bottom() > c.Y
}
