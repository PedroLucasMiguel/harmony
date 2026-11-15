package poll

import (
	"image/color"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	backdropAlpha  = 140
	dialogWidth    = 480
	dialogShare    = 0.9
	dialogHeight   = 0.92
	dialogPadX     = 19.2
	dialogPadY     = 17.6
	dialogEdge     = 0.14
	dialogHeadLine = 24
	dialogHeadGap  = 4.8
	noteSize       = 13.6
	noteLine       = 20.4
	noteGap        = 11.2
	groupGap       = 14.4
	headPadBottom  = 4
	voterTop       = 6.4
	voterGap       = 5.6
	voterAvatar    = 12.6
	voterFont      = 8.4
	voterText      = 23.5
	buttonsTop     = 12.8
)

var (
	dialogTitleStyle = paint.TextStyle{Size: 16, Weight: paint.Semibold}
	noteStyle        = paint.TextStyle{Size: noteSize, Weight: paint.Regular}
	headStyle        = paint.TextStyle{Size: bodySize, Weight: paint.Semibold}
)

// Votes lists everybody who voted, under what they chose. A poll that hides its voters shows the counts and says so.
type Votes struct {
	poll    *hclient.Poll
	results hclient.PollResults
	members []hclient.Account
	scroll  widget.Scroll
	body    votesBody
}

func NewVotes(p *hclient.Poll, members []hclient.Account) *Votes {
	v := &Votes{poll: p, results: resultsOf(p), members: members}
	v.body.v = v
	v.body.close = widget.Button{Variant: widget.Ghost}
	v.scroll.Child, v.scroll.Bar = &v.body, true
	return v
}

func (v *Votes) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: backdropAlpha})
	v.body.close.Label = c.T("poll.close")
	v.body.close.OnClick = c.CloseModal
	card := dialogCard(c, bounds, v.body.Measure(c, min(dialogWidth, bounds.W*dialogShare)-2*c.Hairline()).H)
	c.Layer(v)
	if c.EscapeFor(v) {
		c.Claim()
		c.CloseModal()
		return
	}
	c.Claim()
	paintCard(c, card)
	v.scroll.Draw(c, card.InsetAll(c.Hairline()))
}

// dialogCard is the box a dialog is drawn in: centred, 30 rem wide at most, and never taller than the window.
func dialogCard(c *widget.Context, bounds geom.Rect, content float32) geom.Rect {
	w := min(dialogWidth, bounds.W*dialogShare)
	h := min(content+2*c.Hairline(), bounds.H*dialogHeight)
	return geom.Rect{X: bounds.X + (bounds.W-w)/2, Y: bounds.Y + (bounds.H-h)/2, W: w, H: h}
}

func paintCard(c *widget.Context, card geom.Rect) {
	c.Paint.Fill(card, 10, c.Theme.Surface2)
	c.Paint.Stroke(card, 10, c.Hairline(), theme.WithAlpha(c.Theme.Tint, dialogEdge))
}

// votesBody is the dialog's content. It is measured at two widths in a frame when a scroll bar is needed, so two layouts are kept.
type votesBody struct {
	v     *Votes
	close widget.Button
	slots [2]votesLayout
	next  int
}

type votesLayout struct {
	width float32
	zoom  float32
	title []string
	h     float32
}

func (b *votesBody) layout(c *widget.Context, w float32) *votesLayout {
	for i := range b.slots {
		if s := &b.slots[i]; s.width == w && s.zoom == c.Paint.Zoom {
			return s
		}
	}
	s := &b.slots[b.next]
	b.next = 1 - b.next
	s.width, s.zoom = w, c.Paint.Zoom
	inner := w - 2*dialogPadX
	s.title = wrap(c, b.v.poll.Title, dialogTitleStyle, inner)
	h := 2*dialogPadY + float32(len(s.title))*dialogHeadLine + dialogHeadGap + noteLine + noteGap
	if b.v.poll.Anonymous {
		h += noteLine + noteGap
	}
	for i := range b.v.poll.Options {
		if i > 0 {
			h += groupGap
		}
		h += b.groupHeight(c, i)
	}
	s.h = h + buttonsTop + b.close.Measure(c, 0).H
	return s
}

func (b *votesBody) who(option int) []int {
	if b.v.poll.Anonymous || option >= len(b.v.results.Voters) {
		return nil
	}
	return b.v.results.Voters[option]
}

func (b *votesBody) groupHeight(c *widget.Context, option int) float32 {
	h := bodyLine + headPadBottom + c.Hairline()
	switch n := len(b.who(option)); {
	case n > 0:
		h += voterTop + float32(n)*bodyLine + float32(n-1)*voterGap
	case !b.v.poll.Anonymous:
		h += noteLine + noteGap
	}
	return h
}

func (b *votesBody) Measure(c *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: b.layout(c, w).h}
}

func (b *votesBody) Draw(c *widget.Context, r geom.Rect) {
	l := b.layout(c, r.W)
	p := b.v.poll
	x, w := r.X+dialogPadX, r.W-2*dialogPadX
	y := r.Y + dialogPadY
	for _, line := range l.title {
		c.Paint.Text(line, x, y, dialogHeadLine, dialogTitleStyle, c.Theme.Text)
		y += dialogHeadLine
	}
	y += dialogHeadGap
	total := c.Strings.Plural("poll.votes", b.v.results.Total, "count", itoa(b.v.results.Total))
	c.Paint.Text(total, x, y, noteLine, noteStyle, c.Theme.Muted)
	y += noteLine + noteGap
	if p.Anonymous {
		c.Paint.Text(c.T("poll.voters_hidden"), x, y, noteLine, noteStyle, c.Theme.Muted)
		y += noteLine + noteGap
	}
	for i, text := range p.Options {
		y += b.drawGroup(c, i, text, x, y, w)
		y += groupGap
	}
	y += buttonsTop - groupGap
	size := b.close.Measure(c, 0)
	b.close.Draw(c, geom.Rect{X: x + w - size.W, Y: y, W: size.W, H: size.H})
}

func (b *votesBody) drawGroup(c *widget.Context, option int, text string, x, y, w float32) float32 {
	count := "0"
	if option < len(b.v.results.Counts) {
		count = itoa(b.v.results.Counts[option])
	}
	c.Paint.TextIn(geom.Rect{X: x, Y: y, W: max(0, w-c.Paint.TextWidth(count, headStyle)-colGap), H: bodyLine}, text, x, y, bodyLine, headStyle, c.Theme.Text)
	c.Paint.Text(count, x+w-c.Paint.TextWidth(count, headStyle), y, bodyLine, headStyle, c.Theme.Muted)
	y += bodyLine + headPadBottom
	c.Paint.Fill(geom.Rect{X: x, Y: y, W: w, H: c.Hairline()}, 0, c.Theme.Border)
	y += c.Hairline()
	who := b.who(option)
	for n, id := range who {
		row := y + voterTop + float32(n)*(bodyLine+voterGap)
		name := nameOf(b.v.members, id)
		widget.Avatar{Name: name, Size: voterAvatar, Font: voterFont}.Draw(c, geom.Rect{X: x, Y: row + (bodyLine-voterAvatar)/2, W: voterAvatar, H: voterAvatar})
		c.Paint.TextIn(geom.Rect{X: x + voterText, Y: row, W: max(0, w-voterText), H: bodyLine}, name, x+voterText, row, bodyLine, bodyStyle, c.Theme.Text)
	}
	if len(who) == 0 && !b.v.poll.Anonymous {
		c.Paint.Text(c.T("poll.nobody"), x, y, noteLine, noteStyle, c.Theme.Muted)
	}
	return b.groupHeight(c, option)
}
