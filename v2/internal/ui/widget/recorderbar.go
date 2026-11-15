package widget

import (
	"image/color"
	"math"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

const (
	recBtn        = 38
	recIcon       = 20.8
	recGap        = 9.6
	recPadX       = 1.6
	recDot        = 10.4
	recTimeW      = 41.6
	recTimeSize   = 14
	recTimeLine   = 21
	recLiveH      = 25.6
	recStep       = 5
	recBarW       = 3
	recHairBar    = 2
	recRestAlpha  = 0.35
	recDotPeriod  = 1200 * time.Millisecond
	recDotPaused  = 0.5
	recGain       = 2.2
	recFrame      = 80 * time.Millisecond
	recHoverAlpha = 0.12
	recRadius     = 6
)

var (
	recRed       = color.RGBA{255, 77, 106, 255}
	recTimeStyle = paint.TextStyle{Size: recTimeSize, Weight: paint.Regular}
)

// RecorderBar is what takes the message box's place while a voice message is recorded: discard, a pulsing dot, the time, how loud it has been, pause and send.
type RecorderBar struct {
	Time      string
	Levels    []float32
	Paused    bool
	Ready     bool
	OnDiscard func()
	OnPause   func()
	OnSend    func()
}

func (b *RecorderBar) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: recBtn}
}

func (b *RecorderBar) Draw(c *Context, r geom.Rect) {
	if b.Ready && !b.Paused {
		redraw.After(recFrame)
	}
	x := r.X + recPadX
	b.button(c, geom.Rect{X: x, Y: r.Y, W: recBtn, H: recBtn}, "trash", c.Theme.Muted, true, b.OnDiscard)
	x += recBtn + recGap

	c.Paint.Circle(x+recDot/2, r.Y+r.H/2, recDot/2, theme.WithAlpha(recRed, b.dotAlpha()))
	x += recDot + recGap
	c.Paint.Text(b.Time, x, r.Y+(r.H-recTimeLine)/2, recTimeLine, recTimeStyle, c.Theme.Text)
	x += recTimeW + recGap

	right := r.Right() - recPadX
	send := geom.Rect{X: right - recBtn, Y: r.Y, W: recBtn, H: recBtn}
	pause := geom.Rect{X: send.X - recGap - recBtn, Y: r.Y, W: recBtn, H: recBtn}
	b.drawLive(c, geom.Rect{X: x, Y: r.Y + (r.H-recLiveH)/2, W: max(0, pause.X-recGap-x), H: recLiveH})
	icon := "pause"
	if b.Paused {
		icon = "microphone"
	}
	b.button(c, pause, icon, recRed, false, b.OnPause)
	b.sendButton(c, send)
}

func (b *RecorderBar) dotAlpha() float32 {
	if b.Paused || !b.Ready {
		return recDotPaused
	}
	redraw.After(recFrame)
	phase := float64(time.Now().UnixNano()%int64(recDotPeriod)) / float64(recDotPeriod)
	return float32(0.625 + 0.375*math.Cos(2*math.Pi*phase))
}

func (b *RecorderBar) button(c *Context, r geom.Rect, icon string, ink color.RGBA, fade bool, do func()) {
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, recRadius, theme.WithAlpha(c.Theme.Tint, recHoverAlpha))
		if fade {
			ink = c.Theme.Text
		}
		if c.Clicked(r) {
			c.Claim()
			do()
		}
	}
	c.Paint.Icon(icon, geom.Rect{X: r.X + (r.W-recIcon)/2, Y: r.Y + (r.H-recIcon)/2, W: recIcon, H: recIcon}, ink)
}

func (b *RecorderBar) sendButton(c *Context, r geom.Rect) {
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			b.OnSend()
		}
	}
	c.Paint.Circle(r.X+r.W/2, r.Y+r.H/2, r.W/2, c.Theme.Accent)
	c.Paint.Icon("paper-plane-right", geom.Rect{X: r.X + (r.W-recIcon)/2, Y: r.Y + (r.H-recIcon)/2, W: recIcon, H: recIcon}, rl.White)
}

// drawLive draws the loudness history, the newest on the right and a dotted line before the first.
func (b *RecorderBar) drawLive(c *Context, r geom.Rect) {
	slots := int(r.W / recStep)
	for i := 0; i < slots; i++ {
		from := len(b.Levels) - (slots - i)
		h, alpha := float32(recHairBar), float32(recRestAlpha)
		if from >= 0 {
			h = max(recHairBar, min(r.H, float32(math.Sqrt(float64(b.Levels[from])))*r.H*recGain))
			alpha = 1
		}
		bar := geom.Rect{X: r.X + float32(i)*recStep, Y: r.Y + (r.H-h)/2, W: recBarW, H: h}
		c.Paint.Fill(bar, 0, theme.WithAlpha(c.Theme.Muted, alpha))
	}
}
