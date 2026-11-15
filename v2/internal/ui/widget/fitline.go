package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const fitEllipsis = "…"

// FitLine is one line of text that is cut with an ellipsis where it does not fit, remembered until the text or the width changes.
type FitLine struct {
	Content    string
	Style      paint.TextStyle
	Tone       Tone
	Opacity    float32
	LineHeight float32

	fitted   string
	fitFor   string
	fitWidth float32
}

func (l *FitLine) lineHeight() float32 {
	if l.LineHeight > 0 {
		return l.LineHeight
	}
	return l.Style.Size * 1.5
}

func (l *FitLine) Measure(c *Context, _ float32) geom.Size {
	return geom.Size{W: c.Paint.TextWidth(l.Content, l.Style), H: l.lineHeight()}
}

func (l *FitLine) fit(c *Context, width float32) string {
	if l.fitted != "" && l.fitFor == l.Content && l.fitWidth == width {
		return l.fitted
	}
	l.fitFor, l.fitWidth, l.fitted = l.Content, width, l.Content
	if c.Paint.TextWidth(l.Content, l.Style) <= width {
		return l.fitted
	}
	runes := []rune(l.Content)
	lo, hi := 0, len(runes)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if c.Paint.TextWidth(string(runes[:mid])+fitEllipsis, l.Style) <= width {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	l.fitted = string(runes[:lo]) + fitEllipsis
	return l.fitted
}

func (l *FitLine) Draw(c *Context, r geom.Rect) {
	if l.Content == "" {
		return
	}
	c.Paint.Text(l.fit(c, r.W), r.X, r.Y, l.lineHeight(), l.Style, withOpacity(l.Tone.Color(c.Theme), l.Opacity))
}
