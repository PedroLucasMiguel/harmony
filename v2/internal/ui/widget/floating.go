package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	floatRadius  = 10
	floatShadowY = 8
	floatBlur    = 28
	floatShadowA = 0.45
	floatRing    = 0.18
	floatGrip    = 18
	floatMargin  = 8
	floatCorner  = 24
	gripAlpha    = 0.7
	gripLine     = 1.6
)

var floatBlack = color.RGBA{A: 255}

// Floating is a small window drawn over the page. It sits where it was left, is moved by whatever calls Move and sized by its
// corner, and always stays whole inside the page.
type Floating struct {
	// Rect is the window's place and size from the page's corner, in interface pixels; empty until Fit puts it somewhere.
	Rect geom.Rect

	moving, sizing bool
	mx, my         float32
	from           geom.Rect
}

// Fit puts an unplaced window in the page's lower right corner and keeps a placed one inside the page, whatever the page's
// size has become since.
func (f *Floating) Fit(page geom.Size, usual, least geom.Size) {
	r := &f.Rect
	if r.W == 0 {
		*r = geom.Rect{X: page.W - usual.W - floatCorner, Y: page.H - usual.H - floatCorner, W: usual.W, H: usual.H}
	}
	r.W = max(least.W, min(r.W, page.W-2*floatMargin))
	r.H = max(least.H, min(r.H, page.H-2*floatMargin))
	r.X = max(0, min(r.X, page.W-r.W))
	r.Y = max(0, min(r.Y, page.H-r.H))
}

// Busy says whether the window is being moved or sized.
func (f *Floating) Busy() bool { return f.moving || f.sizing }

// Move starts moving the window from the pointer's place; call it on a press that landed on the bar or the picture.
func (f *Floating) Move(c *Context) {
	if f.sizing {
		return
	}
	f.moving, f.mx, f.my, f.from = true, c.In.MouseX, c.In.MouseY, f.Rect
	c.Claim()
}

// Begin draws the window's shadow and body over the page and returns the room for the bar, of the
// height given, and for what is under it.
func (f *Floating) Begin(c *Context, page geom.Rect, barHeight float32) (bar, body geom.Rect) {
	r := f.screen(page)
	c.Popup(r)
	if grip := gripOf(r); c.Hovered(grip) && c.In.Pressed && !f.Busy() && !c.Claimed() {
		f.sizing, f.mx, f.my, f.from = true, c.In.MouseX, c.In.MouseY, f.Rect
		c.Claim()
	}
	c.Paint.Shadow(r, floatRadius, floatShadowY, floatBlur, theme.WithAlpha(floatBlack, floatShadowA))
	c.Paint.Fill(r, floatRadius, floatBlack)
	return geom.Rect{X: r.X, Y: r.Y, W: r.W, H: barHeight}, geom.Rect{X: r.X, Y: r.Y + barHeight, W: r.W, H: r.H - barHeight}
}

func (f *Floating) screen(page geom.Rect) geom.Rect {
	return geom.Rect{X: page.X + f.Rect.X, Y: page.Y + f.Rect.Y, W: f.Rect.W, H: f.Rect.H}
}

// End draws the ring and the grip, follows a move or a size in progress and reports that one has just ended.
func (f *Floating) End(c *Context, page geom.Rect, least geom.Size) (ended bool) {
	r := f.screen(page)
	c.Paint.Corners(r, floatRadius, c.Theme.Bg)
	c.Paint.Stroke(r, floatRadius, c.Hairline(), theme.WithAlpha(c.Theme.Tint, floatRing))

	grip := gripOf(r)
	hot := c.Hovered(grip) || f.sizing
	if hot {
		c.SetCursor(rl.MouseCursorResizeNWSE)
	}
	f.drawGrip(c, grip, hot)

	if !f.Busy() {
		return false
	}
	if !c.In.Down {
		f.moving, f.sizing = false, false
		return true
	}
	dx, dy := c.In.MouseX-f.mx, c.In.MouseY-f.my
	if f.moving {
		c.SetCursor(rl.MouseCursorResizeAll)
		f.Rect.X = max(0, min(f.from.X+dx, page.W-f.from.W))
		f.Rect.Y = max(0, min(f.from.Y+dy, page.H-f.from.H))
		return false
	}
	w := max(least.W, min(f.from.W+dx, page.W))
	h := max(least.H, min(f.from.H+dy, page.H))
	f.Rect = geom.Rect{X: min(f.from.X, page.W-w), Y: min(f.from.Y, page.H-h), W: w, H: h}
	return false
}

func gripOf(r geom.Rect) geom.Rect {
	return geom.Rect{X: r.Right() - floatGrip, Y: r.Bottom() - floatGrip, W: floatGrip, H: floatGrip}
}

func (f *Floating) drawGrip(c *Context, grip geom.Rect, hot bool) {
	alpha := float32(gripAlpha)
	if hot {
		alpha = 1
	}
	ink := theme.WithAlpha(color.RGBA{R: 255, G: 255, B: 255, A: 255}, alpha)
	right, bottom := grip.Right()-3, grip.Bottom()-3
	for _, reach := range [...]float32{6, 12} {
		c.Paint.Line(right, bottom-reach, right-reach, bottom, gripLine, ink)
	}
}
