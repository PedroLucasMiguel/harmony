package channels

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	listPad      = 9.6
	listGap      = 8
	groupTop     = 6.4
	groupBottom  = 1.6
	groupLine    = 21.6
	groupGapX    = 4.8
	groupIcon    = 15
	groupIconBox = 17.3
	emptyMargin  = 8
	emptyLine    = 21
	moreHeight   = 33.2
)

var groupStyle = paint.TextStyle{Size: 14.4, Weight: paint.Bold}

// colItem is one line of a column of messages: a heading, or a card.
type colItem struct {
	heading string
	card    *msgCard
}

// cardColumn is the scrolling content of the pins, the stars and the search results: headings and cards, or a note when
// there are none, and a button to show more.
type cardColumn struct {
	screen *Screen
	items  []colItem
	empty  string
	more   *widget.Button
	// view is the part of the column that shows; the owner sets it before each draw.
	view geom.Rect
	// reserve is the room a scroll bar takes from the cards' width when they do not fit.
	reserve float32
}

const scrollReserve = 10

// layout builds the cards for the width the column has, and again ten pixels narrower, as the scroll bar takes, when they do not fit in avail.
func (col *cardColumn) layout(c *widget.Context, avail, full float32, build func(width float32)) {
	col.reserve = 0
	build(full)
	if col.height(c) > avail {
		col.reserve = scrollReserve
		build(full - scrollReserve)
	}
}

func (col *cardColumn) height(c *widget.Context) float32 {
	h := float32(2 * listPad)
	if len(col.items) == 0 {
		return h + 2*emptyMargin + emptyLine
	}
	for i, it := range col.items {
		if i > 0 {
			h += listGap
		}
		if it.card != nil {
			h += it.card.height
			continue
		}
		h += groupLine + groupBottom
		if i > 0 {
			h += groupTop
		}
	}
	if col.more != nil {
		h += listGap + moreHeight
	}
	return h
}

func (col *cardColumn) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: col.height(c)}
}

func (col *cardColumn) Draw(c *widget.Context, r geom.Rect) {
	if len(col.items) == 0 {
		text := col.empty
		w := c.Paint.TextWidth(text, noteStyle)
		c.Paint.Text(text, r.X+(r.W-w)/2, r.Y+listPad+emptyMargin, emptyLine, noteStyle, c.Theme.Muted)
		return
	}
	s := col.screen
	y := r.Y + listPad
	width := r.W - 2*listPad - col.reserve
	for i, it := range col.items {
		if i > 0 {
			y += listGap
		}
		if it.card == nil {
			if i > 0 {
				y += groupTop
			}
			col.drawGroup(c, geom.Rect{X: r.X + listPad, Y: y, W: width, H: groupLine}, it.heading)
			y += groupLine + groupBottom
			continue
		}
		card := geom.Rect{X: r.X + listPad, Y: y, W: width, H: it.card.height}
		if card.Bottom() >= col.view.Y && card.Y <= col.view.Bottom() {
			it.card.Draw(s, c, card, col.view)
		}
		y += it.card.height
	}
	if col.more != nil {
		size := col.more.Measure(c, width)
		col.more.Draw(c, geom.Rect{X: r.X + (r.W-size.W)/2, Y: y + listGap, W: size.W, H: size.H})
	}
}

func (col *cardColumn) drawGroup(c *widget.Context, r geom.Rect, name string) {
	c.Paint.Icon("hash", geom.Rect{X: r.X + (groupIconBox-groupIcon)/2, Y: r.Y + (r.H-groupIcon)/2, W: groupIcon, H: groupIcon}, c.Theme.Text)
	c.Paint.Text(name, r.X+groupIconBox+groupGapX, r.Y, r.H, groupStyle, c.Theme.Text)
}

var noteStyle = paint.TextStyle{Size: 14, Weight: paint.Regular}
