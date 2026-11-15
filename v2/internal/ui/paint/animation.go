package paint

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
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
type animation struct {
	g      *gif.GIF
	canvas *image.NRGBA
	saved  *image.NRGBA
	cur    int
	played int
	next   time.Time
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
	a := &animation{g: g, canvas: image.NewNRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))}
	a.paint(0)
	first := image.NewNRGBA(a.canvas.Rect)
	copy(first.Pix, a.canvas.Pix)
	return a, first, cfg.Width, cfg.Height
}

func (a *animation) paint(i int) {
	f := a.g.Image[i]
	if a.g.Disposal != nil && a.g.Disposal[i] == gif.DisposalPrevious {
		if a.saved == nil {
			a.saved = image.NewNRGBA(a.canvas.Rect)
		}
		copy(a.saved.Pix, a.canvas.Pix)
	}
	draw.Draw(a.canvas, f.Bounds(), f, f.Bounds().Min, draw.Over)
	a.cur = i
}

// advance shows the next frame: what the frame shown leaves behind is cleared first.
func (a *animation) advance() {
	last := a.cur
	if a.g.Disposal != nil {
		switch a.g.Disposal[last] {
		case gif.DisposalBackground:
			draw.Draw(a.canvas, a.g.Image[last].Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			if a.saved != nil {
				copy(a.canvas.Pix, a.saved.Pix)
			}
		}
	}
	next := last + 1
	if next == len(a.g.Image) {
		a.played++
		draw.Draw(a.canvas, a.canvas.Rect, image.Transparent, image.Point{}, draw.Src)
		next = 0
	}
	a.paint(next)
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
	for steps := 0; !now.Before(a.next) && !a.finished() && steps < animationCatchUp; steps++ {
		a.advance()
		a.next = a.next.Add(a.delay())
	}
	if now.After(a.next) {
		a.next = now.Add(a.delay())
	}
	p.b.flush()
	pix := a.canvas.Pix
	rl.UpdateTexture(pic.tex, unsafe.Slice((*color.RGBA)(unsafe.Pointer(&pix[0])), len(pix)/4))
	redraw.After(max(time.Until(a.next), time.Millisecond))
}
