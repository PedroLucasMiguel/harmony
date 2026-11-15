package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	waveGap         = 2
	waveBarMin      = 2
	waveBarMax      = 5
	waveRadius      = 2
	waveRest        = 0.35
	wavePlaceholder = 0.2
)

// Waveform is a sound drawn as a row of bars, the played part in the accent colour; pressing it seeks. Without Peaks it draws a flat placeholder.
type Waveform struct {
	Peaks    []byte
	Bars     int
	Progress float32
	OnSeek   func(fraction float32)
}

func (w *Waveform) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: 32}
}

func (w *Waveform) Draw(c *Context, r geom.Rect) {
	n := max(w.Bars, 1)
	width := min(max((r.W-float32(n-1)*waveGap)/float32(n), waveBarMin), waveBarMax)
	for i := 0; i < n; i++ {
		level := float32(wavePlaceholder)
		if i < len(w.Peaks) {
			level = float32(w.Peaks[i]) / 255
		}
		h := level * r.H
		bar := geom.Rect{X: r.X + float32(i)*(width+waveGap), Y: r.Y + (r.H-h)/2, W: width, H: h}
		if (float32(i)+0.5)/float32(n) <= w.Progress {
			c.Paint.Fill(bar, waveRadius, c.Theme.Accent)
		} else {
			c.Paint.Fill(bar, waveRadius, theme.WithAlpha(c.Theme.Muted, waveRest))
		}
	}
	if c.Hovered(r) && w.OnSeek != nil {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			w.OnSeek(min(max((c.In.MouseX-r.X)/r.W, 0), 1))
		}
	}
}
