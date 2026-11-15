package about

import (
	"image/color"
	"strings"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	logoSize    = 60
	titleSize   = 24
	titleLine   = 36
	versionSize = 13.6
	versionLine = 20.4
	taglineMax  = 384
	headBottom  = 14.4
	sectionPad  = 7.2
	headingSize = 12.48
	headingLine = 18.72
	headingGap  = 4.8
	listColGap  = 19.2
	listRowGap  = 4
)

// head is the logo, the name, the version and what Harmony is.
type head struct{ version, tagline string }

func (h head) wrapped(c *widget.Context, width float32) []string {
	var lines []string
	line := ""
	for _, word := range strings.Fields(h.tagline) {
		next := word
		if line != "" {
			next = line + " " + word
		}
		if line != "" && c.Paint.TextWidth(next, bodyStyle) > min(width, taglineMax) {
			lines, next = append(lines, line), word
		}
		line = next
	}
	return append(lines, line)
}

func (h head) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: logoSize + 6.4 + titleLine + 3.2 + versionLine + 4.8 + float32(len(h.wrapped(c, maxWidth)))*bodyLine + headBottom}
}

func (h head) Draw(c *widget.Context, r geom.Rect) {
	cx := r.X + r.W/2
	widget.Logo{Size: logoSize, Tone: widget.ToneAccent}.Draw(c, geom.Rect{X: cx - logoSize/2, Y: r.Y})
	y := r.Y + logoSize + 6.4
	centred(c, "Harmony", cx, y, titleLine, paint.TextStyle{Size: titleSize, Weight: paint.Bold}, c.Theme.Text)
	y += titleLine + 3.2
	label := c.T("about.version") + " "
	style, bold := paint.TextStyle{Size: versionSize, Weight: paint.Regular}, paint.TextStyle{Size: versionSize, Weight: paint.Bold}
	lw, nw := c.Paint.TextWidth(label, style), c.Paint.TextWidth(h.version, bold)
	x := cx - (lw+nw)/2
	c.Paint.Text(label, x, y, versionLine, style, c.Theme.Muted)
	c.Paint.Text(h.version, x+lw, y, versionLine, bold, c.Theme.Text)
	y += versionLine + 4.8
	for i, line := range h.wrapped(c, r.W) {
		centred(c, line, cx, y+float32(i)*bodyLine, bodyLine, bodyStyle, c.Theme.Muted)
	}
}

func centred(c *widget.Context, s string, cx, y, line float32, st paint.TextStyle, ink color.RGBA) {
	c.Paint.Text(s, cx-c.Paint.TextWidth(s, st)/2, y, line, st, ink)
}

// section is a titled block under a faint line.
type section struct {
	title string
	body  widget.Component
	last  bool
}

func (s section) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: c.Hairline() + 2*sectionPad + headingLine + headingGap + s.body.Measure(c, maxWidth).H}
}

func (s section) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
	y := r.Y + c.Hairline() + sectionPad
	st := paint.TextStyle{Size: headingSize, Weight: paint.Bold, Spacing: headingSize * 0.06}
	c.Paint.Text(widget.Upper(s.title), r.X, y, headingLine, st, theme.WithAlpha(c.Theme.Text, 0.7))
	y += headingLine + headingGap
	s.body.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: s.body.Measure(c, r.W).H})
}

// flowList is short items side by side that wrap onto new rows.
type flowList struct{ items []*inline }

func (l *flowList) Measure(c *widget.Context, maxWidth float32) geom.Size {
	_, h := l.place(c, maxWidth, nil)
	return geom.Size{W: maxWidth, H: h}
}

func (l *flowList) Draw(c *widget.Context, r geom.Rect) {
	l.place(c, r.W, func(it *inline, x, y, w float32) {
		it.Draw(c, geom.Rect{X: r.X + x, Y: r.Y + y, W: w, H: bodyLine})
	})
}

func (l *flowList) place(c *widget.Context, width float32, at func(*inline, float32, float32, float32)) (float32, float32) {
	x, y := float32(0), float32(0)
	for _, it := range l.items {
		w := it.natural(c)
		if x > 0 && x+w > width {
			x, y = 0, y+bodyLine+listRowGap
		}
		if at != nil {
			at(it, x, y, w+1)
		}
		x += w + listColGap
	}
	return width, y + bodyLine
}
