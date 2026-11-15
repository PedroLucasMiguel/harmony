package widget

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

type Text struct {
	Content    string
	Style      paint.TextStyle
	Tone       Tone
	LineHeight float32
	Upper      bool
	Wrap       bool
	Opacity    float32
}

func Label(content string, size float32, weight paint.Weight, tone Tone) *Text {
	return &Text{Content: content, Style: paint.TextStyle{Size: size, Weight: weight}, Tone: tone}
}

func (t *Text) lineHeight() float32 {
	if t.LineHeight > 0 {
		return t.LineHeight
	}
	return t.Style.Size * 1.5
}

func (t *Text) display() string {
	if t.Upper {
		return Upper(t.Content)
	}
	return t.Content
}

func (t *Text) lines(c *Context, maxWidth float32) []string {
	return wrap(c, t.display(), t.Style, maxWidth)
}

func (t *Text) Measure(c *Context, maxWidth float32) geom.Size {
	if !t.Wrap {
		return geom.Size{W: c.Paint.TextWidth(t.display(), t.Style), H: t.lineHeight()}
	}
	lines := t.lines(c, maxWidth)
	widest := float32(0)
	for _, line := range lines {
		widest = max(widest, c.Paint.TextWidth(line, t.Style))
	}
	return geom.Size{W: widest, H: float32(len(lines)) * t.lineHeight()}
}

func (t *Text) Draw(c *Context, r geom.Rect) {
	if !t.Wrap {
		c.Paint.Text(t.display(), r.X, r.Y, t.lineHeight(), t.Style, withOpacity(t.Tone.Color(c.Theme), t.Opacity))
		return
	}
	for i, line := range t.lines(c, r.W) {
		c.Paint.Text(line, r.X, r.Y+float32(i)*t.lineHeight(), t.lineHeight(), t.Style, withOpacity(t.Tone.Color(c.Theme), t.Opacity))
	}
}

func withOpacity(col color.RGBA, opacity float32) color.RGBA {
	if opacity == 0 {
		return col
	}
	return theme.WithAlpha(col, opacity*float32(col.A)/255)
}
