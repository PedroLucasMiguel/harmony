package about

import (
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	bodySize = 14.08
	bodyLine = 21.12
)

// part is a stretch of a line: plain, quiet, or a link to the browser.
type part struct {
	text  string
	url   string
	muted bool
}

// inline is parts flowing across lines like a paragraph, a link underlined while the pointer is on it.
type inline struct {
	parts []part
	laid  []placed
	width float32
	for_  *widget.Context
}

type placed struct {
	text string
	x, y float32
	w    float32
	part int
}

func (l *inline) style() paint.TextStyle {
	return paint.TextStyle{Size: bodySize, Weight: paint.Regular}
}

func (l *inline) layout(c *widget.Context, width float32) float32 {
	if l.width == width && l.for_ == c && l.laid != nil {
		return l.height()
	}
	l.width, l.for_, l.laid = width, c, l.laid[:0]
	x, y := float32(0), float32(0)
	space := c.Paint.TextWidth(" ", l.style())
	gap := false
	for i, p := range l.parts {
		gap = gap || strings.HasPrefix(p.text, " ")
		for _, word := range strings.Fields(p.text) {
			w := c.Paint.TextWidth(word, l.style())
			if gap && x > 0 {
				x += space
			}
			if x > 0 && x+w > width {
				x, y = 0, y+bodyLine
			}
			l.laid = append(l.laid, placed{text: word, x: x, y: y, w: w, part: i})
			x += w
			gap = true
		}
		gap = strings.HasSuffix(p.text, " ")
	}
	return l.height()
}

func (l *inline) height() float32 {
	if len(l.laid) == 0 {
		return bodyLine
	}
	return l.laid[len(l.laid)-1].y + bodyLine
}

func (l *inline) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: l.layout(c, maxWidth)}
}

func (l *inline) Draw(c *widget.Context, r geom.Rect) {
	l.layout(c, r.W)
	for _, w := range l.laid {
		p := l.parts[w.part]
		box := geom.Rect{X: r.X + w.x, Y: r.Y + w.y, W: w.w, H: bodyLine}
		ink := c.Theme.Text
		switch {
		case p.url != "":
			ink = c.Theme.Accent
		case p.muted:
			ink = c.Theme.Muted
		}
		c.Paint.Text(w.text, box.X, box.Y, bodyLine, l.style(), ink)
		if p.url != "" && c.Hovered(box) {
			c.SetCursor(rl.MouseCursorPointingHand)
			c.Paint.Fill(geom.Rect{X: box.X, Y: box.Y + bodyLine/2 + bodySize*0.55, W: box.W, H: c.Hairline()}, 0, ink)
			if c.In.Pressed {
				c.Claim()
				rl.OpenURL(p.url)
			}
		}
	}
}

// natural is the width the parts take on one line.
func (l *inline) natural(c *widget.Context) float32 {
	l.layout(c, 1e6)
	if len(l.laid) == 0 {
		return 0
	}
	last := l.laid[len(l.laid)-1]
	return last.x + last.w
}
