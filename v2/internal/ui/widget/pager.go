package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	pagerButton  = 32
	pagerPadX    = 8
	pagerGap     = 4
	pagerFont    = 14.08
	pagerHover   = 0.1
	pagerDimmed  = 0.4
	pagerGapMark = 0.5
)

var pagerStyle = paint.TextStyle{Size: pagerFont, Weight: paint.Regular}

// Pager is a row of page buttons: Previous, the first and last pages and the ones around the current one, Next.
type Pager struct {
	Pages, At  int
	Prev, Next string
	OnPage     func(page int)
}

func (p *Pager) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: pagerButton}
}

// shown lists the pages that get a button, in order.
func (p *Pager) shown() (list [5]int, n int) {
	for _, page := range [...]int{0, p.At - 1, p.At, p.At + 1, p.Pages - 1} {
		if page >= 0 && page < p.Pages && (n == 0 || page > list[n-1]) {
			list[n] = page
			n++
		}
	}
	return list, n
}

func (p *Pager) width(c *Context, label string) float32 {
	return max(pagerButton, c.Paint.TextWidth(label, pagerStyle)+2*pagerPadX)
}

func (p *Pager) Draw(c *Context, r geom.Rect) {
	pages, n := p.shown()
	var buf [20]byte
	total := p.width(c, p.Prev) + p.width(c, p.Next) + pagerGap
	for i := range n {
		total += pagerGap + p.width(c, string(appendInt(buf[:0], pages[i]+1)))
		if i > 0 && pages[i]-pages[i-1] > 1 {
			total += pagerGap + c.Paint.TextWidth("…", pagerStyle)
		}
	}
	x := r.X + (r.W-total)/2
	x += p.button(c, x, r.Y, p.Prev, p.At-1, p.At == 0, false)
	last := -1
	for i := range n {
		x += pagerGap
		if pages[i]-last > 1 && i > 0 {
			w := c.Paint.TextWidth("…", pagerStyle)
			c.Paint.Text("…", x, r.Y+(pagerButton-pagerFont*1.5)/2, pagerFont*1.5, pagerStyle, theme.WithAlpha(c.Theme.Text, pagerGapMark))
			x += w + pagerGap
		}
		x += p.button(c, x, r.Y, string(appendInt(buf[:0], pages[i]+1)), pages[i], false, pages[i] == p.At)
		last = pages[i]
	}
	x += pagerGap
	p.button(c, x, r.Y, p.Next, p.At+1, p.At >= p.Pages-1, false)
}

func (p *Pager) button(c *Context, x, y float32, label string, page int, disabled, here bool) float32 {
	w := p.width(c, label)
	box := geom.Rect{X: x, Y: y, W: w, H: pagerButton}
	ink := c.Theme.Text
	hovered := !disabled && c.Hovered(box)
	switch {
	case here:
		c.Paint.Fill(box, pagerButton/2, c.Theme.Accent)
		ink = ToneOnAccent.Color(c.Theme)
	case hovered:
		c.Paint.Fill(box, pagerButton/2, theme.WithAlpha(c.Theme.Tint, pagerHover))
	}
	if disabled {
		ink = theme.WithAlpha(ink, pagerDimmed)
	}
	c.Paint.Text(label, x+(w-c.Paint.TextWidth(label, pagerStyle))/2, y+(pagerButton-pagerFont*1.5)/2, pagerFont*1.5, pagerStyle, ink)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			p.OnPage(page)
		}
	}
	return w
}

func appendInt(b []byte, n int) []byte {
	if n >= 10 {
		b = appendInt(b, n/10)
	}
	return append(b, byte('0'+n%10))
}
