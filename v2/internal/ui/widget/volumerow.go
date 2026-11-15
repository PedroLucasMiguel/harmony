package widget

import (
	"image/color"
	"strconv"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

const (
	volumePadX      = 8
	volumePadY      = 3.2
	volumeGap       = 9.6
	volumeLabelMin  = 44.8
	volumeLabelSize = 12.48
	volumeLabelLine = 18.72
	volumeTrack     = 6
	volumeThumb     = 18
	volumeRing      = 3
	volumeTrackA    = 0.18
	volumeNotches   = 40
	volumeSettle    = 250 * time.Millisecond
	volumeBoostSign = " ⚠"
	stripPad        = 0
	stripGap        = 4.8
	stripLabelMin   = 41.6
	stripLabelSize  = 11.52
	stripLabelLine  = 17.28
	stripLabelAlpha = 0.6
	stripHeight     = 18
	exactPadX       = 3
	exactPadY       = 1
	exactRadius     = 4
	exactWidth      = 3.2 * volumeLabelSize
)

var (
	volumeStyle = paint.TextStyle{Size: volumeLabelSize, Weight: paint.Regular}
	boostStyle  = paint.TextStyle{Size: volumeLabelSize, Weight: paint.Semibold}

	stripStyle      = paint.TextStyle{Size: stripLabelSize, Weight: paint.Regular}
	stripBoostStyle = paint.TextStyle{Size: stripLabelSize, Weight: paint.Semibold}
)

// VolumeRow is a slider with its percentage beside it. Pressing the number lets a value be typed in.
// OnChange follows every move; OnSettle comes once a drag, a wheel turn or a typed value is done.
type VolumeRow struct {
	Value int
	Max   int
	// Strip is the row of a player's strip: no padding, a smaller and fainter number, close to the slider.
	Strip bool
	// Muted shows MutedText where the number is: the person is silenced however far the slider is.
	Muted     bool
	MutedText string
	OnChange  func(percent int)
	OnSettle  func(percent int)

	dragging bool
	carry    float32
	settleAt time.Time
	waiting  bool

	editing bool
	typed   string
	fresh   bool
	focus   Focus

	shown int
	label string
}

// Reset drops a half-typed value and a drag, as when the row is shown afresh.
func (v *VolumeRow) Reset() { v.editing, v.dragging, v.waiting, v.carry = false, false, false, 0 }

// Flush reports a change that has not settled yet, as when the row is closed before it does.
func (v *VolumeRow) Flush() {
	if !v.waiting {
		return
	}
	v.waiting = false
	if v.OnSettle != nil {
		v.OnSettle(v.Value)
	}
}

func (v *VolumeRow) Measure(*Context, float32) geom.Size {
	if v.Strip {
		return geom.Size{H: stripHeight}
	}
	return geom.Size{H: 2*volumePadY + volumeLabelLine}
}

// metrics are the row's own padding, the gap before the number and the number's least width, line and look.
func (v *VolumeRow) metrics() (padX, padY, gap, labelMin, line float32, style paint.TextStyle) {
	switch {
	case v.Strip && v.boosted():
		return stripPad, 0, stripGap, stripLabelMin, stripLabelLine, stripBoostStyle
	case v.Strip:
		return stripPad, 0, stripGap, stripLabelMin, stripLabelLine, stripStyle
	case v.boosted():
		return volumePadX, volumePadY, volumeGap, volumeLabelMin, volumeLabelLine, boostStyle
	}
	return volumePadX, volumePadY, volumeGap, volumeLabelMin, volumeLabelLine, volumeStyle
}

func (v *VolumeRow) boosted() bool { return v.Value > 100 && !v.Muted }

func (v *VolumeRow) text() string {
	if v.Muted {
		return v.MutedText
	}
	if v.label == "" || v.shown != v.Value {
		v.shown = v.Value
		v.label = strconv.Itoa(v.Value) + "%"
		if v.boosted() {
			v.label += volumeBoostSign
		}
	}
	return v.label
}

func (v *VolumeRow) Draw(c *Context, r geom.Rect) {
	v.settleWhenStill()
	padX, padY, gap, labelMin, line, style := v.metrics()
	inner := geom.Rect{X: r.X + padX, Y: r.Y + padY, W: r.W - 2*padX, H: line}
	if v.Strip {
		inner.Y = r.Y + (r.H-line)/2
	}
	labelW := max(labelMin, c.Paint.TextWidth(v.text(), style))
	if v.editing {
		labelW = max(labelW, exactBoxWidth(c))
	}
	label := geom.Rect{X: inner.Right() - labelW, Y: inner.Y, W: labelW, H: inner.H}
	slider := geom.Rect{X: inner.X, Y: r.Y, W: label.X - gap - inner.X, H: r.H}
	v.drawSlider(c, slider)
	if v.editing {
		v.drawEditor(c, label)
	} else {
		v.drawLabel(c, label, style, line)
	}
}

func (v *VolumeRow) settleWhenStill() {
	if !v.waiting || v.dragging {
		return
	}
	if wait := time.Until(v.settleAt); wait > 0 {
		redraw.After(wait)
		return
	}
	v.Flush()
}

func (v *VolumeRow) set(percent int) {
	percent = min(max(percent, 0), v.Max)
	if percent == v.Value {
		return
	}
	v.Value = percent
	v.waiting, v.settleAt = true, time.Now().Add(volumeSettle)
	if v.OnChange != nil {
		v.OnChange(percent)
	}
}

func (v *VolumeRow) drawSlider(c *Context, r geom.Rect) {
	travel := r.W - volumeThumb
	hovered := c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if wheel := c.In.Wheel; wheel != 0 {
			v.carry += wheel * float32(max(1, v.Max/volumeNotches))
			whole := int(v.carry)
			v.carry -= float32(whole)
			v.set(v.Value + whole)
		}
	}
	if hovered && c.In.Pressed {
		c.Claim()
		v.dragging = true
	}
	if v.dragging {
		if !c.In.Down {
			v.dragging = false
		} else {
			v.set(int((c.In.MouseX-r.X-volumeThumb/2)/travel*float32(v.Max) + 0.5))
		}
	}

	accent := c.Theme.Accent
	if v.boosted() {
		accent = c.Theme.Warn
	}
	track := geom.Rect{X: r.X, Y: r.Y + (r.H-volumeTrack)/2, W: r.W, H: volumeTrack}
	fill := track
	fill.W = track.W * float32(v.Value) / float32(v.Max)
	c.Paint.Fill(track, volumeTrack/2, theme.WithAlpha(c.Theme.Tint, volumeTrackA))
	c.Paint.Fill(fill, volumeTrack/2, accent)
	tick := track.X + track.W*100/float32(v.Max)
	c.Paint.Fill(geom.Rect{X: tick - 1, Y: track.Y, W: 2, H: track.H}, 0, c.Theme.Text)

	cx, cy := r.X+volumeThumb/2+travel*float32(v.Value)/float32(v.Max), r.Y+r.H/2
	radius := float32(volumeThumb / 2)
	if hovered || v.dragging {
		radius *= 1.08
	}
	if v.dragging {
		c.Paint.Circle(cx, cy, radius+4, theme.WithAlpha(accent, 0.3))
	}
	c.Paint.Shadow(geom.Rect{X: cx - radius, Y: cy - radius, W: 2 * radius, H: 2 * radius}, radius, 1, 4, color.RGBA{A: 115})
	c.Paint.Circle(cx, cy, radius, c.Theme.Surface2)
	c.Paint.Circle(cx, cy, radius-volumeRing, accent)
}

func (v *VolumeRow) drawLabel(c *Context, r geom.Rect, style paint.TextStyle, line float32) {
	ink := c.Theme.Text
	switch {
	case v.boosted():
		ink = c.Theme.Warn
	case v.Strip:
		ink = theme.WithAlpha(ink, stripLabelAlpha)
	}
	text := v.text()
	width := c.Paint.TextWidth(text, style)
	x := r.Right() - width
	c.Paint.Text(text, x, r.Y, line, style, ink)
	if !c.Hovered(r) {
		return
	}
	c.SetCursor(rl.MouseCursorIBeam)
	y := r.Y + line - 3
	for dot := x; dot < x+width; dot += 3 {
		c.Paint.Fill(geom.Rect{X: dot, Y: y, W: 1, H: 1}, 0, ink)
	}
	if c.In.Pressed {
		c.Claim()
		c.Focus(&v.focus)
		v.editing, v.fresh, v.typed = true, true, strconv.Itoa(v.Value)
	}
}

func exactBoxWidth(c *Context) float32 {
	return exactWidth + 2*exactPadX + 2*c.Hairline() + 1 + c.Paint.TextWidth("%", volumeStyle)
}

func (v *VolumeRow) drawEditor(c *Context, r geom.Rect) {
	c.Register(&v.focus)
	if !c.Focused(&v.focus) {
		v.finish(true)
		return
	}
	c.Layer(v)
	for _, ch := range c.In.Typed {
		if ch < '0' || ch > '9' {
			continue
		}
		if v.fresh {
			v.typed, v.fresh = "", false
		}
		if len(v.typed) < 3 {
			v.typed += string(ch)
		}
	}
	if c.In.Backspace {
		if v.fresh {
			v.typed, v.fresh = "", false
		} else if v.typed != "" {
			v.typed = v.typed[:len(v.typed)-1]
		}
	}
	switch {
	case c.In.Enter:
		v.finish(true)
		return
	case c.EscapeFor(v):
		c.In.Escape = false
		v.finish(false)
		return
	}

	box := geom.Rect{X: r.Right() - exactBoxWidth(c), Y: r.Y + (r.H-volumeLabelLine)/2, W: exactWidth + 2*exactPadX + 2*c.Hairline(), H: volumeLabelLine - 2*exactPadY}
	box.Y = r.Y + (r.H-box.H)/2
	c.Paint.Fill(box, exactRadius, c.Theme.Bg)
	c.Paint.Stroke(box, exactRadius, c.Hairline(), c.Theme.Accent)
	width := c.Paint.TextWidth(v.typed, volumeStyle)
	x := box.Right() - c.Hairline() - exactPadX - width
	top := box.Y + (box.H-volumeLabelLine)/2
	if v.fresh {
		c.Paint.Fill(geom.Rect{X: x, Y: top + 2, W: width, H: volumeLabelLine - 4}, 0, theme.WithAlpha(c.Theme.Accent, 0.35))
	}
	c.Paint.Text(v.typed, x, top, volumeLabelLine, volumeStyle, c.Theme.Text)
	if !v.fresh && c.Blink() {
		c.Paint.Fill(geom.Rect{X: x + width, Y: top + 2, W: 1, H: volumeLabelLine - 4}, 0, c.Theme.Text)
	}
	c.Paint.Text("%", box.Right()+1, r.Y, volumeLabelLine, volumeStyle, c.Theme.Text)
}

func (v *VolumeRow) finish(keep bool) {
	v.editing = false
	if !keep || v.typed == "" {
		return
	}
	if n, err := strconv.Atoi(v.typed); err == nil {
		v.set(n)
	}
}
