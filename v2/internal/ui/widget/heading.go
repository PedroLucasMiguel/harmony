package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	headingSize    = 15.2
	headingSpacing = 0.06
	headingAlpha   = 0.7
	headingGap     = 8
	headingCount   = 14
)

// Heading is a column's title in capitals, with an optional quieter count beside it.
type Heading struct {
	Title string
	Count string
	// CountGap is the space between the title and the count.
	CountGap float32
}

func (h Heading) title() Text {
	return Text{
		Content: h.Title, Upper: true, Tone: ToneText, Opacity: headingAlpha,
		Style:      paint.TextStyle{Size: headingSize, Weight: paint.Semibold, Spacing: headingSize * headingSpacing},
		LineHeight: headingSize * 1.5,
	}
}

func (h Heading) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: headingSize*1.5 + headingGap}
}

func (h Heading) Draw(c *Context, r geom.Rect) {
	title := h.title()
	width := title.Measure(c, r.W).W
	title.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: headingSize * 1.5})
	if h.Count == "" {
		return
	}
	count := Text{Content: h.Count, Style: paint.TextStyle{Size: headingCount, Weight: paint.Regular}, Tone: ToneMuted}
	count.Draw(c, geom.Rect{X: r.X + width + h.CountGap, Y: r.Y + (headingSize*1.5-headingCount*1.5)/2 + 0.4, W: r.W, H: headingCount * 1.5})
}
