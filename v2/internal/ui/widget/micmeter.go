package widget

import (
	"math"
	"time"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

const (
	meterHeight     = 9.6
	meterTop        = 9.6
	meterTrackAlpha = 0.14
	meterGatedAlpha = 0.3
	meterMarkWidth  = 2
	meterMarkReach  = 2
	meterFullScale  = 0.25
	meterRefresh    = 60 * time.Millisecond
)

// MicMeter is the bar that shows how loud the microphone is, with a marker where the noise gate sits. It reads its numbers as it is drawn
// and asks for a frame again while it is on screen, so it costs nothing once its page is closed.
type MicMeter struct {
	// Level is the microphone's RMS, 0 to 1; Mark is the gate's threshold, 0 for none; Gated says the gate is shut.
	Level func() float64
	Mark  func() float64
	Gated func() bool
}

// meterPercent puts an RMS on the bar, as a share of its width: the square root, because loudness is.
func meterPercent(rms float64) float32 {
	return float32(min(1, math.Sqrt(max(0, rms)/meterFullScale)))
}

func (m *MicMeter) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: meterTop + meterHeight}
}

func (m *MicMeter) Draw(c *Context, r geom.Rect) {
	bar := geom.Rect{X: r.X, Y: r.Y + meterTop, W: r.W, H: meterHeight}
	c.Paint.Fill(bar, meterHeight/2, theme.WithAlpha(c.Theme.Tint, meterTrackAlpha))
	fill := c.Theme.Live
	if m.Gated() {
		fill = theme.WithAlpha(c.Theme.Tint, meterGatedAlpha)
	}
	if w := bar.W * meterPercent(m.Level()); w > 0 {
		c.Paint.Fill(geom.Rect{X: bar.X, Y: bar.Y, W: w, H: bar.H}, min(meterHeight, w)/2, fill)
	}
	if mark := m.Mark(); mark > 0 {
		x := bar.X + bar.W*meterPercent(mark) - meterMarkWidth/2
		c.Paint.Fill(geom.Rect{X: x, Y: bar.Y - meterMarkReach, W: meterMarkWidth, H: bar.H + 2*meterMarkReach}, 0, c.Theme.Warn)
	}
	redraw.After(meterRefresh)
}
