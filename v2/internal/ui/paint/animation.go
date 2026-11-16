package paint

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"time"
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/redraw"
)

const (
	animationMaxBytes = 96 << 20
	animationMinDelay = 20 * time.Millisecond
	animationSlowest  = 100 * time.Millisecond
	animationCatchUp  = 4
)

// animation is the frames of an animated GIF; it is stepped only while the picture is drawn, so one that is out of sight costs nothing.
// Frames are painted straight into canvas through their palette, and only the rows a step changed go to the GPU.
type animation struct {
	g      *gif.GIF
	w, h   int
	canvas []color.RGBA
	saved  []color.RGBA
	cur    int
	played int
	next   time.Time

	// dirtyTop and dirtyBottom are the rows of the canvas changed since the last upload; none when top is not above bottom.
	dirtyTop, dirtyBottom int

	palFirst *color.Color
	palLen   int
	lut      [256]color.RGBA
	opaque   [256]bool
}

// decodeAnimation reads a GIF with more than one frame: the animation, and its first frame to show at once. Anything else, or a GIF too large to keep, is not animated.
func decodeAnimation(data []byte) (*animation, *image.NRGBA, int, int) {
	if !bytes.HasPrefix(data, []byte("GIF8")) {
		return nil, nil, 0, 0
	}
	cfg, err := gif.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width == 0 || cfg.Height == 0 || max(cfg.Width, cfg.Height) > pictureMaxEdge {
		return nil, nil, 0, 0
	}
	g, err := gif.DecodeAll(bytes.NewReader(data))
	if err != nil || len(g.Image) < 2 || len(g.Image)*cfg.Width*cfg.Height > animationMaxBytes {
		return nil, nil, 0, 0
	}
	a := &animation{g: g, w: cfg.Width, h: cfg.Height, canvas: make([]color.RGBA, cfg.Width*cfg.Height)}
	a.paint(0)
	a.dirtyTop, a.dirtyBottom = a.h, 0
	// The first picture is the canvas itself: nothing steps the animation before its texture exists.
	first := &image.NRGBA{Pix: unsafe.Slice((*byte)(unsafe.Pointer(&a.canvas[0])), len(a.canvas)*4), Stride: a.w * 4, Rect: image.Rect(0, 0, a.w, a.h)}
	return a, first, a.w, a.h
}

// bytes is the memory the animation holds beyond its canvas: every frame's pixels.
func (a *animation) bytes() int {
	n := 0
	for _, f := range a.g.Image {
		n += len(f.Pix)
	}
	return n
}

func (a *animation) mark(top, bottom int) {
	a.dirtyTop, a.dirtyBottom = min(a.dirtyTop, top), max(a.dirtyBottom, bottom)
}

func (a *animation) disposal(i int) byte {
	if i < len(a.g.Disposal) {
		return a.g.Disposal[i]
	}
	return gif.DisposalNone
}

func (a *animation) loadPalette(p color.Palette) {
	if len(p) > 0 && &p[0] == a.palFirst && len(p) == a.palLen {
		return
	}
	a.palFirst, a.palLen = nil, len(p)
	if len(p) > 0 {
		a.palFirst = &p[0]
	}
	a.opaque = [256]bool{}
	for i, c := range p[:min(len(p), 256)] {
		r, g, b, al := c.RGBA()
		if al == 0 {
			continue
		}
		a.opaque[i] = true
		a.lut[i] = color.RGBA{R: uint8(r * 0xffff / al >> 8), G: uint8(g * 0xffff / al >> 8), B: uint8(b * 0xffff / al >> 8), A: uint8(al >> 8)}
	}
}

func (a *animation) paint(i int) {
	f := a.g.Image[i]
	if a.disposal(i) == gif.DisposalPrevious {
		a.saved = append(a.saved[:0], a.canvas...)
	}
	a.loadPalette(f.Palette)
	b := f.Rect.Intersect(image.Rect(0, 0, a.w, a.h))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		src := f.Pix[(y-f.Rect.Min.Y)*f.Stride+b.Min.X-f.Rect.Min.X:][:b.Dx()]
		dst := a.canvas[y*a.w+b.Min.X:][:len(src)]
		for x, index := range src {
			if a.opaque[index] {
				dst[x] = a.lut[index]
			}
		}
	}
	a.mark(b.Min.Y, b.Max.Y)
	a.cur = i
}

// advance shows the next frame, after clearing what the frame shown leaves behind. It returns false when the animation has played its last loop: the last frame stays.
func (a *animation) advance() bool {
	last := a.cur
	next := last + 1
	if next == len(a.g.Image) {
		a.played++
		if a.finished() {
			return false
		}
		clear(a.canvas)
		a.mark(0, a.h)
		next = 0
	} else {
		switch a.disposal(last) {
		case gif.DisposalBackground:
			a.clearRect(a.g.Image[last].Rect)
		case gif.DisposalPrevious:
			copy(a.canvas, a.saved)
			a.mark(0, a.h)
		}
	}
	a.paint(next)
	return true
}

func (a *animation) clearRect(r image.Rectangle) {
	b := r.Intersect(image.Rect(0, 0, a.w, a.h))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		clear(a.canvas[y*a.w+b.Min.X : y*a.w+b.Max.X])
	}
	a.mark(b.Min.Y, b.Max.Y)
}

func (a *animation) finished() bool {
	return a.g.LoopCount < 0 && a.played > 0 || a.g.LoopCount > 0 && a.played > a.g.LoopCount
}

func (a *animation) delay() time.Duration {
	d := time.Duration(a.g.Delay[a.cur]) * 10 * time.Millisecond
	if d < animationMinDelay {
		d = animationSlowest
	}
	return d
}

// animate moves an animated picture on to the frame that is due and asks for the one after; it runs when the picture is drawn.
func (p *Painter) animate(pic *Picture) {
	a := pic.anim
	if a == nil || a.finished() {
		return
	}
	now := time.Now()
	if a.next.IsZero() {
		a.next = now.Add(a.delay())
	}
	if now.Before(a.next) {
		redraw.After(a.next.Sub(now))
		return
	}
	for steps := 0; !now.Before(a.next) && steps < animationCatchUp; steps++ {
		if !a.advance() {
			break
		}
		a.next = a.next.Add(a.delay())
	}
	if now.After(a.next) {
		a.next = now.Add(a.delay())
	}
	if a.dirtyTop < a.dirtyBottom {
		p.b.flush()
		rows := a.canvas[a.dirtyTop*a.w : a.dirtyBottom*a.w]
		rl.UpdateTextureRec(pic.tex, rl.Rectangle{Y: float32(a.dirtyTop), Width: float32(a.w), Height: float32(a.dirtyBottom - a.dirtyTop)}, rows)
		if pic.sized {
			rl.GenTextureMipmaps(&pic.tex)
		}
		a.dirtyTop, a.dirtyBottom = a.h, 0
	}
	if !a.finished() {
		redraw.After(max(time.Until(a.next), time.Millisecond))
	}
}
