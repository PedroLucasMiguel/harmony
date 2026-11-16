package paint

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"math"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

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

// Sizer holds the files of small pictures and cuts a still one to the size it will be drawn.
type Sizer interface {
	Data(key string) ([]byte, error)
	Render(data []byte, shape Shape, w, h int) (*image.NRGBA, error)
}

const (
	// A size nobody has asked for in sizedIdle is let go of: a window being dragged passes through hundreds of sizes and
	// leaves every one of them behind. The check runs at most once in sweepEvery.
	sizedIdle  = 3 * time.Second
	sweepEvery = time.Second
)

var errDropped = errors.New("this size is not asked for any more")

// Sized is the picture under key made by src at w by h device pixels. It costs a map lookup once loaded, and nothing is allocated.
// A still picture is cut to that size once; a GIF that moves is one animation at its own size, cut by the GPU at every size.
func (p *Painter) Sized(shape Shape, key string, w, h int, src Sizer) *Picture {
	ps := p.pictures
	k := picKey{key, int32(w)<<16 | int32(h), shape}
	now := time.Now().UnixNano()
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if pic, ok := ps.items[k]; ok && !pic.gone() {
		pic.seen = now
		return pic
	}
	if now-ps.swept > int64(sweepEvery) {
		ps.sweep(now)
	}
	pic := &Picture{seen: now}
	ps.items[k] = pic
	go ps.load(pic, func() (*image.NRGBA, int, int, error) {
		if pic.isDead() {
			return nil, 0, 0, errDropped
		}
		data, err := src.Data(key)
		if err != nil {
			return nil, 0, 0, err
		}
		if bytes.HasPrefix(data, gifMagic) {
			if shared := ps.shareAnimation(key, shape, data); shared != nil {
				pic.mu.Lock()
				pic.redirect = shared
				pic.mu.Unlock()
				return nil, 0, 0, nil
			}
		}
		img, err := src.Render(data, shape, w, h)
		if err != nil {
			return nil, 0, 0, err
		}
		return img, w, h, nil
	})
	return pic
}

var gifMagic = []byte("GIF8")

func (pic *Picture) isDead() bool {
	pic.mu.Lock()
	defer pic.mu.Unlock()
	return pic.dead
}

// gone is a size that stands for an animation whose texture has been let go of; it is made again.
func (pic *Picture) gone() bool {
	t := pic.target()
	if t == pic {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.evicted
}

// shareAnimation is the one picture of a GIF that moves, made when the first size of it loads; nil when the GIF is not
// one that can be played, which is then cut to size like any still picture.
func (ps *pictures) shareAnimation(key string, shape Shape, data []byte) *Picture {
	k := picKey{key: key, px: -1, kind: shape}
	ps.mu.Lock()
	shared := ps.items[k]
	ps.mu.Unlock()
	if shared != nil {
		return shared
	}
	a, first, w, h := decodeAnimation(data)
	if a == nil {
		return nil
	}
	ps.mu.Lock()
	shared = ps.items[k]
	fresh := shared == nil
	if fresh {
		shared = &Picture{anim: a, sized: true, round: shape == Round}
		ps.items[k] = shared
	}
	ps.mu.Unlock()
	if fresh {
		ps.finish(shared, first, w, h, nil)
	}
	return shared
}

// sweep lets go of the sizes that have not been asked for lately; the caller holds ps.mu.
func (ps *pictures) sweep(now int64) {
	ps.swept = now
	for k, pic := range ps.items {
		if k.px <= 0 || now-pic.seen < int64(sizedIdle) {
			continue
		}
		pic.mu.Lock()
		pic.dead = true
		live := pic.live
		pic.mu.Unlock()
		if live {
			rl.UnloadTexture(pic.tex)
			ps.bytes -= pic.cost
		}
		delete(ps.items, k)
	}
}

// coverUV is the part of a w by h texture, in texture coordinates, that fills a box of r's proportions.
func coverUV(w, h float32, r geom.Rect) (u0, v0, u1, v1 float32) {
	u0, v0, u1, v1 = 0, 0, 1, 1
	if want, have := r.W/r.H, w/h; have > want {
		span := want / have
		u0, u1 = (1-span)/2, (1+span)/2
	} else {
		span := have / want
		v0, v1 = (1-span)/2, (1+span)/2
	}
	return
}

// drawRounded draws the middle of a texture inside a rounded rectangle, a circle when radius is half the side, with an edge
// one device pixel wide that fades out. The outline is four corner arcs; a fan from the middle fills it and a ring outside it
// is the soft edge.
func (p *Painter) drawRounded(tex rl.Texture2D, r geom.Rect, radius float32, tint color.RGBA) {
	u0, v0, u1, v1 := coverUV(float32(tex.Width), float32(tex.Height), r)
	x0, y0, x1, y1 := p.px(r.X), p.px(r.Y), p.px(r.Right()), p.px(r.Bottom())
	rad := min(p.px(radius), (x1-x0)/2, (y1-y0)/2)
	edge := 0.5 / p.dpi
	steps := min(max(int(math.Ceil(math.Pi/2*math.Sqrt(float64(rad*p.dpi)/0.4))), 3), 24)
	n := 4 * (steps + 1)
	v, ix, base := p.b.reserve(tex.ID, 1+2*n, 9*n)
	uv := func(x, y float32) (float32, float32) {
		return u0 + (x-x0)/(x1-x0)*(u1-u0), v0 + (y-y0)/(y1-y0)*(v1-v0)
	}
	clear := color.RGBA{R: tint.R, G: tint.G, B: tint.B}
	v[0] = vertex{(x0 + x1) / 2, (y0 + y1) / 2, (u0 + u1) / 2, (v0 + v1) / 2, tint}
	corners := [4][3]float32{{x1 - rad, y0 + rad, -math.Pi / 2}, {x1 - rad, y1 - rad, 0}, {x0 + rad, y1 - rad, math.Pi / 2}, {x0 + rad, y0 + rad, math.Pi}}
	i := 0
	for _, k := range corners {
		for s := 0; s <= steps; s++ {
			sin, cos := math.Sincos(float64(k[2]) + float64(s)*math.Pi/2/float64(steps))
			px, py := k[0]+rad*float32(cos), k[1]+rad*float32(sin)
			nx, ny := float32(cos)*edge, float32(sin)*edge
			ui, vi := uv(px-nx, py-ny)
			uo, vo := uv(px+nx, py+ny)
			v[1+i] = vertex{px - nx, py - ny, ui, vi, tint}
			v[1+n+i] = vertex{px + nx, py + ny, uo, vo, clear}
			i++
		}
	}
	for i := range n {
		j := (i + 1) % n
		o, a, b := base, base+1+uint16(i), base+1+uint16(j)
		oa, ob := base+1+uint16(n+i), base+1+uint16(n+j)
		k := 9 * i
		ix[k], ix[k+1], ix[k+2] = o, b, a
		ix[k+3], ix[k+4], ix[k+5] = a, ob, oa
		ix[k+6], ix[k+7], ix[k+8] = a, b, ob
	}
}

// DrawSizedRounded is DrawSized with the corners cut round by the GPU, so that it sits on any picture, not just a flat colour.
func (p *Painter) DrawSizedRounded(pic *Picture, r geom.Rect, radius, alpha float32) bool {
	pic = pic.target()
	if pic.State() != PictureReady {
		return false
	}
	tex, live := p.texture(pic)
	if !live {
		return false
	}
	p.drawRounded(tex, r, radius, color.RGBA{255, 255, 255, uint8(alpha*255 + 0.5)})
	return true
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
	pic = pic.target()
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
	pic = pic.target()
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
	u0, v0, u1, v1 := float32(0), float32(0), float32(1), float32(1)
	if pic.sized {
		u0, v0, u1, v1 = coverUV(float32(tex.Width), float32(tex.Height), r)
	}
	x := [3]float32{r.X, r.X + r.W*fadeStart, r.Right()}
	u := [3]float32{u0, u0 + (u1-u0)*fadeStart, u1}
	a := [3]color.RGBA{alpha(0), alpha(fadeAt), alpha(1)}
	y0, y1 := p.px(r.Y), p.px(r.Bottom())
	v, ix, base := p.b.reserve(tex.ID, 6, 12)
	for i := range 3 {
		px := p.px(x[i])
		v[2*i] = vertex{px, y0, u[i], v0, a[i]}
		v[2*i+1] = vertex{px, y1, u[i], v1, a[i]}
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
