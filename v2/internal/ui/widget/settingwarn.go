package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	warnSize = 12.48
	warnLine = warnSize * 1.5
)

// SettingWarn is a line in the warning colour under a group of controls, for what was found or done about them: nothing while it is empty.
type SettingWarn struct {
	Content string
	// Top is the room kept above it while it has something to say.
	Top float32
}

func (w SettingWarn) text() *Text {
	return &Text{Content: w.Content, Style: paint.TextStyle{Size: warnSize, Weight: paint.Regular}, LineHeight: warnLine, Tone: ToneWarn, Wrap: true}
}

func (w SettingWarn) Measure(c *Context, maxWidth float32) geom.Size {
	if w.Content == "" {
		return geom.Size{W: maxWidth}
	}
	return geom.Size{W: maxWidth, H: w.Top + w.text().Measure(c, maxWidth).H}
}

func (w SettingWarn) Draw(c *Context, r geom.Rect) {
	if w.Content != "" {
		w.text().Draw(c, geom.Rect{X: r.X, Y: r.Y + w.Top, W: r.W, H: r.H - w.Top})
	}
}
