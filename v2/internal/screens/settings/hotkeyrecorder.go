package settings

import (
	"harmony/v2/internal/hotkey"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/input"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	captureMinWidth = 288
	capturePadY     = 14.4
	captureSize     = 16.8
	captureRadius   = 8
	captureErrGap   = 6.4
	captureErrSize  = 12.48
)

// recorder is the box in the hotkey dialog that shows what is being pressed and takes the first valid combination.
type recorder struct {
	allowBare bool
	held      string
	problem   string
	done      func(accelerator string)
	finished  bool
}

func (r *recorder) text(c *widget.Context) string {
	if r.held != "" {
		return r.held
	}
	return c.T("app.waiting_for_keys_or_mouse")
}

func (r *recorder) Measure(c *widget.Context, maxWidth float32) geom.Size {
	h := float32(2*capturePadY + captureSize*1.5)
	if r.problem != "" {
		h += captureErrGap + captureErrSize*1.5
	}
	return geom.Size{W: maxWidth, H: h}
}

func (r *recorder) Draw(c *widget.Context, bounds geom.Rect) {
	redraw.Request()
	chord, down := input.ReadChord()
	mods := hotkey.Build(chord.Ctrl, chord.Alt, chord.Shift, chord.Meta, "", isMac)
	r.held = hotkey.Format(mods)
	if r.held != "" {
		r.held += " + …"
	}
	if down && chord.Key != "" && !r.finished {
		accelerator := hotkey.Build(chord.Ctrl, chord.Alt, chord.Shift, chord.Meta, chord.Key, isMac)
		r.held = hotkey.Format(accelerator)
		combo, _ := hotkey.Parse(accelerator)
		switch code := hotkey.Check(combo, r.allowBare, isMac); code {
		case "":
			r.problem, r.finished = "", true
			r.done(accelerator)
		default:
			r.problem = c.T("hotkeys." + code)
		}
	}
	box := geom.Rect{X: bounds.X, Y: bounds.Y, W: bounds.W, H: 2*capturePadY + captureSize*1.5}
	c.Paint.Fill(box, captureRadius, c.Theme.Bg)
	c.Paint.Stroke(box, captureRadius, c.Hairline()*2, c.Theme.Accent)
	style := paint.TextStyle{Size: captureSize, Weight: paint.Semibold}
	text := r.text(c)
	width := c.Paint.TextWidth(text, style)
	c.Paint.Text(text, box.X+(box.W-width)/2, box.Y+capturePadY, captureSize*1.5, style, c.Theme.Text)
	if r.problem != "" {
		warn := &widget.Text{Content: r.problem, Wrap: true, Tone: widget.ToneWarn, Style: paint.TextStyle{Size: captureErrSize, Weight: paint.Regular}}
		warn.Draw(c, geom.Rect{X: bounds.X, Y: box.Bottom() + captureErrGap, W: bounds.W, H: captureErrSize * 1.5})
	}
}
