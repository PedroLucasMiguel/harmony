// Package paint draws the interface in CSS pixels on top of raylib: rectangles, text, icons and masks.
package paint

import (
	"image/color"
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
)

type Painter struct {
	shaper   *shaper
	atlas    *atlas
	masks    *masks
	pictures *pictures
	Zoom     float32
	// TextScale grows the type alone (1 is as drawn); 0 means 1.
	TextScale float32
	dpi       float32
	clips     []geom.Rect
	b         *batch
	path      [][2]float32
}

func New(zoom float32) (*Painter, error) {
	faces, err := loadTypefaces()
	if err != nil {
		return nil, err
	}
	dpi := rl.GetWindowScaleDPI().X
	painter := &Painter{shaper: newShaper(faces), atlas: newAtlas(), masks: newMasks(), pictures: newPictures(), Zoom: zoom, dpi: dpi, b: newBatch(dpi)}
	painter.b.prepare = painter.atlas.run
	return painter, nil
}

// Flush draws what has been painted so far; the frame's last call, before the buffers are swapped.
func (p *Painter) Flush() { p.b.flush() }

func (p *Painter) Close() {
	p.b.close()
	p.atlas.close()
	p.masks.close()
}

func (p *Painter) px(css float32) float32 { return css * p.Zoom }

func (p *Painter) snap(css float32) float32 {
	return float32(math.Round(float64(p.px(css)*p.dpi))) / p.dpi
}

func (p *Painter) rect(r geom.Rect) rl.Rectangle {
	x, y := p.snap(r.X), p.snap(r.Y)
	return rl.Rectangle{X: x, Y: y, Width: p.snap(r.Right()) - x, Height: p.snap(r.Bottom()) - y}
}

func (p *Painter) ToCSS(logical float32) float32 { return logical / p.Zoom }

// DPI is how many device pixels one window unit is.
func (p *Painter) DPI() float32 { return p.dpi }

const cornerSegments = 24

func roundness(r geom.Rect, radius float32) float32 {
	if radius <= 0 {
		return 0
	}
	return min(1, radius*2/min(r.W, r.H))
}

func (p *Painter) Fill(r geom.Rect, radius float32, c color.RGBA) {
	rec := p.rect(r)
	if radius <= 0 {
		p.solidRect(rec.X, rec.Y, rec.Width, rec.Height, c)
		return
	}
	p.solidRounded(rec.X, rec.Y, rec.Width, rec.Height, roundness(r, radius), c)
}

// Shadow softens the edge below a rectangle with a few faint, growing copies of it.
func (p *Painter) Shadow(r geom.Rect, radius, dy, blur float32, c color.RGBA) {
	const layers = 6
	for i := layers; i >= 1; i-- {
		grow := blur * float32(i) / layers / 2
		layer := geom.Rect{X: r.X - grow, Y: r.Y + dy - grow, W: r.W + 2*grow, H: r.H + 2*grow}
		alpha := uint8(float32(c.A) / layers * (1.2 - float32(i)/layers*0.6))
		p.Fill(layer, radius+grow, color.RGBA{R: c.R, G: c.G, B: c.B, A: alpha})
	}
}

func (p *Painter) Stroke(r geom.Rect, radius, width float32, c color.RGBA) {
	rec := p.rect(r)
	if radius <= 0 {
		p.solidRectLines(rec.X, rec.Y, rec.Width, rec.Height, p.px(width), c)
		return
	}
	p.solidRoundedLines(rec.X, rec.Y, rec.Width, rec.Height, roundness(r, radius), p.px(width), c)
}

func (p *Painter) Circle(cx, cy, radius float32, c color.RGBA) {
	p.solidCircle(p.px(cx), p.px(cy), p.px(radius), c)
}

// DashedRoundRect strokes the inside edge of a rounded rectangle with dashes of the given length and gap.
func (p *Painter) DashedRoundRect(r geom.Rect, radius, width, dash, gap float32, c color.RGBA) {
	p.path = roundRectPath(p.path[:0], r.InsetAll(width/2), min(radius, r.W/2, r.H/2)-width/2)
	path := p.path
	period := dash + gap
	var walked float32
	for i := 0; i < len(path); i++ {
		a, b := path[i], path[(i+1)%len(path)]
		length := float32(math.Hypot(float64(b[0]-a[0]), float64(b[1]-a[1])))
		for at := float32(0); at < length; {
			phase := float32(math.Mod(float64(walked+at), float64(period)))
			var run float32
			if phase < dash {
				run = min(dash-phase, length-at)
				from, to := lerp2(a, b, at/length), lerp2(a, b, (at+run)/length)
				p.solidLine(point{p.px(from[0]), p.px(from[1])}, point{p.px(to[0]), p.px(to[1])}, p.px(width), c)
			} else {
				run = min(period-phase, length-at)
			}
			at += max(run, dashMinStep)
		}
		walked += length
	}
}

func (p *Painter) Line(x1, y1, x2, y2, width float32, c color.RGBA) {
	p.solidLine(point{p.px(x1), p.px(y1)}, point{p.px(x2), p.px(y2)}, p.px(width), c)
}

func (p *Painter) Triangle(a, b, c [2]float32, col color.RGBA) {
	p.solidTriangle(point{p.px(a[0]), p.px(a[1])}, point{p.px(b[0]), p.px(b[1])}, point{p.px(c[0]), p.px(c[1])}, col)
}

// TextIn draws text that is cut off at clip's edge; the clip is only set when the text would cross it, because each one flushes a draw batch.
func (p *Painter) TextIn(clip geom.Rect, s string, x, top, lineHeight float32, st TextStyle, c color.RGBA) {
	if x+p.TextWidth(s, st) <= clip.Right() {
		p.Text(s, x, top, lineHeight, st, c)
		return
	}
	p.PushClip(clip)
	p.Text(s, x, top, lineHeight, st, c)
	p.PopClip()
}

// PushClip cuts drawing off at r, within any clip already in force; PopClip goes back to the one before.
func (p *Painter) PushClip(r geom.Rect) {
	if n := len(p.clips); n > 0 {
		r = r.Intersect(p.clips[n-1])
	}
	p.clips = append(p.clips, r)
	p.b.clip = p.scissor(r)
}

func (p *Painter) PopClip() {
	p.clips = p.clips[:len(p.clips)-1]
	if n := len(p.clips); n > 0 {
		p.b.clip = p.scissor(p.clips[n-1])
		return
	}
	p.b.clip = scissor{}
}

func (p *Painter) scissor(r geom.Rect) scissor {
	return scissor{on: true, x: int32(math.Floor(float64(p.px(r.X)))), y: int32(math.Floor(float64(p.px(r.Y)))),
		w: int32(math.Ceil(float64(p.px(r.W)))), h: int32(math.Ceil(float64(p.px(r.H))))}
}

// scaled is st with the text size setting applied.
func (p *Painter) scaled(st TextStyle) TextStyle {
	if p.TextScale != 0 && p.TextScale != 1 {
		st.Size *= p.TextScale
		st.Spacing *= p.TextScale
	}
	return st
}

func (p *Painter) TextWidth(s string, st TextStyle) float32 {
	return p.shaper.shape(s, p.scaled(st)).width
}

func (p *Painter) Ascent(st TextStyle) float32 {
	ascent, _ := p.shaper.verticalMetrics(p.scaled(st))
	return ascent
}

func (p *Painter) ContentHeight(st TextStyle) float32 {
	ascent, descent := p.shaper.verticalMetrics(p.scaled(st))
	return ascent + descent
}

func (p *Painter) Text(s string, x, top, lineHeight float32, st TextStyle, c color.RGBA) {
	baseline := top + (lineHeight-p.ContentHeight(st))/2 + p.Ascent(st)
	st = p.scaled(st)
	run := p.shaper.shape(s, st)
	scale := p.Zoom * p.dpi
	originX, originY := math.Round(float64(x*scale)), math.Round(float64(baseline*scale))
	if run.place.scale != scale {
		p.place(run, st.Size, scale)
	}
	ox, oy := float32(originX), float32(originY)
	for i := range run.place.glyphs {
		g := &run.place.glyphs[i]
		b := g.bitmap
		x0, y0 := (ox+g.dx)/p.dpi, (oy+g.dy)/p.dpi
		p.texturedQuad(b.texture, x0, y0, x0+b.w/p.dpi, y0+b.h/p.dpi, b.u0, b.v0, b.u1, b.v1, false, c)
	}
	p.drawEmoji(run, originX, originY, float64(st.Size), c)
}

func (p *Painter) Mask(name string, r geom.Rect, tint color.RGBA) { p.mask(name, false, r, tint) }

func (p *Painter) Icon(name string, r geom.Rect, tint color.RGBA) { p.mask(name, true, r, tint) }

func (p *Painter) mask(name string, icon bool, r geom.Rect, tint color.RGBA) {
	w, h := int(math.Round(float64(p.px(r.W)*p.dpi))), int(math.Round(float64(p.px(r.H)*p.dpi)))
	t, ok := p.masks.texture(name, icon, w, h)
	if !ok {
		return
	}
	p.textureRect(t.ID, p.rect(r), 0, 0, 1, 1, false, tint)
}

const (
	dashCornerSteps = 16
	dashMinStep     = 0.01
)

func roundRectPath(path [][2]float32, r geom.Rect, radius float32) [][2]float32 {
	corners := [4][3]float32{
		{r.Right() - radius, r.Y + radius, -math.Pi / 2},
		{r.Right() - radius, r.Bottom() - radius, 0},
		{r.X + radius, r.Bottom() - radius, math.Pi / 2},
		{r.X + radius, r.Y + radius, math.Pi},
	}
	for _, corner := range corners {
		for step := 0; step <= dashCornerSteps; step++ {
			angle := float64(corner[2]) + float64(step)/dashCornerSteps*math.Pi/2
			path = append(path, [2]float32{corner[0] + radius*float32(math.Cos(angle)), corner[1] + radius*float32(math.Sin(angle))})
		}
	}
	return path
}

func lerp2(a, b [2]float32, t float32) [2]float32 {
	return [2]float32{a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t}
}

// Clipped is whether the point is cut off by the clip in force: what is drawn there is not seen, so it must not be pressed.
func (p *Painter) Clipped(x, y float32) bool {
	n := len(p.clips)
	return n > 0 && !p.clips[n-1].Contains(x, y)
}
