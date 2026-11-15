// Package poll is a poll on the screen: the card it is shown as in a message, the list of who voted, and the dialog it is made in.
// The card draws from a plain value and reports a click through a callback, so a channel's message and a private conversation's use it alike.
package poll

import (
	"slices"
	"strconv"
	"sync/atomic"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	maxWidth    = 416
	padX        = 14.4
	padTop      = 12.8
	padBottom   = 9.6
	partGap     = 8.8
	titleSize   = 16
	titleLine   = 20.8
	smallSize   = 12.48
	smallLine   = 18.72
	descSize    = 14.4
	descLine    = 21.6
	bodySize    = 14
	bodyLine    = 21
	coverMaxH   = 224
	coverRadius = 8
	optionGap   = 9.6
	rowGap      = 4.8
	colGap      = 9.6
	barHeight   = 4.8
	checkSize   = 20.8
	checkGap    = 9.6
	boxRadius   = 6
	tickWidth   = 1.74
	faceSize    = 22.4
	faceStep    = 16
	faceRing    = 2
	faceFont    = 8.8
	faceMax     = 3
	sideGap     = 7.2
	viewMargin  = 1.6
	viewPadTop  = 8
	viewPadBot  = 1.6
	dimmed      = 0.45
	barAlpha    = 0.12
	closeSlack  = 50 * time.Millisecond
)

var (
	titleStyle = paint.TextStyle{Size: titleSize, Weight: paint.Bold}
	smallStyle = paint.TextStyle{Size: smallSize, Weight: paint.Regular}
	descStyle  = paint.TextStyle{Size: descSize, Weight: paint.Regular}
	bodyStyle  = paint.TextStyle{Size: bodySize, Weight: paint.Regular}
	mineStyle  = paint.TextStyle{Size: bodySize, Weight: paint.Semibold}
	viewStyle  = paint.TextStyle{Size: bodySize, Weight: paint.Semibold}
)

// Source is what a card draws from. Cover is nil until the picture has been fetched.
type Source struct {
	Poll    *hclient.Poll
	Members []hclient.Account
	Cover   *paint.Picture
}

// Card is one poll on the screen. Its layout is kept between frames and rebuilt only when the poll, its votes, the width or the people change.
type Card struct {
	// OnVote is given everything chosen after a click. The card ignores clicks until Busy is cleared.
	OnVote  func(options []int)
	OnCover func()
	Busy    atomic.Bool

	lay layout
}

type face struct{ initials string }

type option struct {
	lines   []string
	count   string
	countW  float32
	faces   []face
	sideW   float32
	sideH   float32
	choiceH float32
	rowH    float32
	top     float32
	pct     float32
	mine    bool
}

type layout struct {
	poll    *hclient.Poll
	results *hclient.PollResults
	members []hclient.Account
	width   float32
	zoom    float32
	closed  bool
	coverW  int
	coverH  int

	w, h           float32
	title, sub     []string
	desc, footer   []string
	titleY, subY   float32
	descY, coverY  float32
	coverBox       float32
	optsY, footerY float32
	metaY, viewY   float32
	opts           []option
	total, ends    string
	endsW          float32
	subText        string
}

func (k *Card) Height(c *widget.Context, s Source, w float32) float32 {
	return k.fit(c, s, w).h
}

func sameMembers(a, b []hclient.Account) bool {
	return len(a) == len(b) && (len(a) == 0 || &a[0] == &b[0])
}

func (k *Card) fit(c *widget.Context, s Source, w float32) *layout {
	l := &k.lay
	closed := chat.PollClosed(s.Poll, time.Now())
	cw, ch := 0, 0
	if s.Cover != nil {
		cw, ch, _ = s.Cover.Size()
	}
	if l.poll == s.Poll && l.results == s.Poll.Results && l.width == w && l.zoom == c.Paint.Zoom && l.closed == closed &&
		l.coverW == cw && l.coverH == ch && sameMembers(l.members, s.Members) {
		return l
	}
	*l = layout{poll: s.Poll, results: s.Poll.Results, members: s.Members, width: w, zoom: c.Paint.Zoom, closed: closed, coverW: cw, coverH: ch}
	l.build(c, s)
	return l
}

func (l *layout) build(c *widget.Context, s Source) {
	p := s.Poll
	edge := c.Hairline()
	l.w = min(maxWidth, l.width)
	inner := l.w - 2*(edge+padX)
	results := resultsOf(p)

	l.title = wrap(c, p.Title, titleStyle, inner)
	l.subText = c.T("poll.select_one")
	switch {
	case l.closed:
		l.subText = c.T("poll.final")
	case p.Multiple:
		l.subText = c.T("poll.select_many")
	}
	if p.Anonymous {
		l.subText = c.T("poll.anonymous") + " · " + l.subText
	}
	l.sub = wrap(c, l.subText, smallStyle, inner)
	if p.Description != "" {
		l.desc = wrap(c, p.Description, descStyle, inner)
	}
	if p.Footer != "" {
		l.footer = wrap(c, p.Footer, smallStyle, inner)
	}

	y := edge + padTop
	l.titleY = y
	y += float32(len(l.title))*titleLine + partGap
	l.subY = y
	y += float32(len(l.sub))*smallLine + partGap
	if len(l.desc) > 0 {
		l.descY = y
		y += float32(len(l.desc))*descLine + partGap
	}
	if l.coverW > 0 && l.coverH > 0 {
		l.coverY = y
		l.coverBox = min(coverMaxH, inner*float32(l.coverH)/float32(l.coverW))
		y += l.coverBox + partGap
	}
	l.optsY = y
	l.layoutOptions(c, results, inner, s.Members)
	for i := range l.opts {
		l.opts[i].top = y
		y += l.opts[i].rowH + 2*rowGap + optionGap
	}
	y += partGap - optionGap
	if len(l.footer) > 0 {
		l.footerY = y
		y += float32(len(l.footer))*smallLine + partGap
	}
	l.metaY = y
	y += smallLine + partGap + viewMargin
	l.viewY = y
	y += edge + viewPadTop + bodyLine + viewPadBot + padBottom + edge
	l.h = y

	l.total = c.Strings.Plural("poll.votes", results.Total, "count", strconv.Itoa(results.Total))
	switch {
	case p.EndsAt == 0:
	case l.closed:
		l.ends = c.T("poll.closed")
	default:
		amount, unit := chat.PollTimeLeft(p, time.Now())
		l.ends = c.Strings.Plural("poll.left_"+string(unit), amount, "count", strconv.Itoa(amount))
	}
	l.endsW = c.Paint.TextWidth(l.ends, smallStyle)
}

func (l *layout) layoutOptions(c *widget.Context, r hclient.PollResults, inner float32, members []hclient.Account) {
	zero := c.Paint.TextWidth("0", bodyStyle)
	most := float32(max(1, r.Total))
	l.opts = make([]option, len(l.poll.Options))
	for i, text := range l.poll.Options {
		o := &l.opts[i]
		count := 0
		if i < len(r.Counts) {
			count = r.Counts[i]
		}
		o.count = strconv.Itoa(count)
		o.countW = max(zero, c.Paint.TextWidth(o.count, bodyStyle))
		o.mine = slices.Contains(r.Mine, i)
		if i < len(r.Voters) {
			who := r.Voters[i]
			for _, id := range who[max(0, len(who)-faceMax):] {
				o.faces = append(o.faces, face{initials: widget.Initials(nameOf(members, id))})
			}
		}
		o.sideW, o.sideH = o.countW, bodyLine
		if n := len(o.faces); n > 0 {
			o.sideW += faceSize + float32(n-1)*faceStep + sideGap
			o.sideH = faceSize
		}
		style := bodyStyle
		if o.mine {
			style = mineStyle
		}
		o.lines = wrap(c, text, style, max(0, inner-o.sideW-colGap-checkSize-checkGap))
		o.choiceH = max(checkSize, float32(len(o.lines))*bodyLine)
		o.rowH = max(o.choiceH, o.sideH)
		o.pct = float32(int(float64(count)/float64(most)*100 + 0.5))
	}
}

func resultsOf(p *hclient.Poll) hclient.PollResults {
	if p.Results == nil {
		return hclient.PollResults{Counts: make([]int, len(p.Options))}
	}
	return *p.Results
}

func nameOf(members []hclient.Account, id int) string {
	for _, a := range members {
		if a.ID == id {
			return a.Name()
		}
	}
	return "?"
}

// Draw paints the card with its top left corner at x, y; Height must have been asked with the same width.
func (k *Card) Draw(c *widget.Context, s Source, x, y, w float32) {
	l := k.fit(c, s, w)
	edge := c.Hairline()
	r := geom.Rect{X: x, Y: y, W: l.w, H: l.h}
	c.Paint.Fill(r, c.Theme.Radius, c.Theme.Surface2)
	c.Paint.Stroke(r, c.Theme.Radius, edge, c.Theme.Border)
	ix, inner := x+edge+padX, l.w-2*(edge+padX)
	muted := c.Theme.Muted

	for i, line := range l.title {
		c.Paint.Text(line, ix, y+l.titleY+float32(i)*titleLine, titleLine, titleStyle, c.Theme.Text)
	}
	for i, line := range l.sub {
		c.Paint.Text(line, ix, y+l.subY+float32(i)*smallLine, smallLine, smallStyle, muted)
	}
	for i, line := range l.desc {
		c.Paint.Text(line, ix, y+l.descY+float32(i)*descLine, descLine, descStyle, c.Theme.Text)
	}
	if l.coverBox > 0 {
		k.drawCover(c, s, geom.Rect{X: ix, Y: y + l.coverY, W: inner, H: l.coverBox})
	}
	enabled := !l.closed && !k.Busy.Load()
	for i := range l.opts {
		k.drawOption(c, s.Poll, l, i, ix, y+l.opts[i].top, inner, enabled)
	}
	for i, line := range l.footer {
		c.Paint.Text(line, ix, y+l.footerY+float32(i)*smallLine, smallLine, smallStyle, muted)
	}
	c.Paint.Text(l.total, ix, y+l.metaY, smallLine, smallStyle, muted)
	if l.ends != "" {
		c.Paint.Text(l.ends, ix+inner-l.endsW, y+l.metaY, smallLine, smallStyle, muted)
	}
	k.drawView(c, s, geom.Rect{X: ix, Y: y + l.viewY, W: inner, H: edge + viewPadTop + bodyLine + viewPadBot})
	if !l.closed && s.Poll.EndsAt != 0 {
		redraw.After(time.Until(time.UnixMilli(s.Poll.EndsAt)) + closeSlack)
	}
}

func (k *Card) drawCover(c *widget.Context, s Source, r geom.Rect) {
	c.Paint.DrawPicture(s.Cover, r, coverRadius, true, c.Theme.Surface2)
	if k.OnCover != nil && c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			k.OnCover()
		}
	}
}

func (k *Card) drawOption(c *widget.Context, p *hclient.Poll, l *layout, i int, x, y, w float32, enabled bool) {
	o := &l.opts[i]
	text := c.Theme.Text
	strong := c.Theme.BorderStrong
	alpha := float32(1)
	if !enabled {
		alpha = dimmed
	}
	choiceW := w - o.sideW - colGap
	choice := geom.Rect{X: x, Y: y + (o.rowH-o.choiceH)/2, W: choiceW, H: o.choiceH}
	hovered := enabled && c.Hovered(choice)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		strong = c.Theme.Accent
		if c.Clicked(choice) {
			c.Claim()
			k.click(p, i)
		}
	}
	box := geom.Rect{X: x, Y: choice.Y + (o.choiceH-checkSize)/2, W: checkSize, H: checkSize}
	radius := float32(checkSize / 2)
	if p.Multiple {
		radius = boxRadius
	}
	if o.mine {
		c.Paint.Fill(box, radius, theme.WithAlpha(c.Theme.Accent, alpha))
		drawTick(c, box, theme.WithAlpha(rl.White, alpha))
	} else {
		c.Paint.Stroke(box, radius, 2*c.Hairline(), theme.WithAlpha(strong, alpha))
	}
	for n, line := range o.lines {
		style := bodyStyle
		if o.mine {
			style = mineStyle
		}
		c.Paint.Text(line, x+checkSize+checkGap, choice.Y+float32(n)*bodyLine, bodyLine, style, theme.WithAlpha(text, alpha))
	}

	side := geom.Rect{X: x + w - o.sideW, Y: y + (o.rowH-o.sideH)/2, W: o.sideW, H: o.sideH}
	for n, f := range o.faces {
		cx, cy := side.X+float32(n)*faceStep+faceSize/2, side.Y+o.sideH/2
		c.Paint.Circle(cx, cy, faceSize/2+faceRing, c.Theme.Surface2)
		widget.Avatar{Initials: f.initials, Size: faceSize, Font: faceFont}.Draw(c, geom.Rect{X: cx - faceSize/2, Y: cy - faceSize/2, W: faceSize, H: faceSize})
	}
	c.Paint.Text(o.count, side.Right()-o.countW, side.Y+(o.sideH-bodyLine)/2, bodyLine, bodyStyle, c.Theme.Muted)

	bar := geom.Rect{X: x, Y: y + o.rowH + rowGap, W: w, H: barHeight}
	c.Paint.Fill(bar, barHeight/2, theme.WithAlpha(c.Theme.Tint, barAlpha))
	if fill := w * o.pct / 100; fill > 0 {
		ink := c.Theme.Accent
		if l.closed {
			ink = c.Theme.Muted
		}
		c.Paint.Fill(geom.Rect{X: bar.X, Y: bar.Y, W: max(fill, barHeight), H: barHeight}, barHeight/2, ink)
	}
}

// drawTick is the check mark of a chosen option: a long stroke and a short one meeting below the middle of the box.
func drawTick(c *widget.Context, box geom.Rect, ink rl.Color) {
	cx, cy := box.X+box.W/2, box.Y+box.H/2
	vx, vy := cx-1.7, cy+4.1
	c.Paint.Line(vx-3.4, vy-3.4, vx, vy, tickWidth, ink)
	c.Paint.Line(vx, vy, vx+6.8, vy-6.8, tickWidth, ink)
}

func (k *Card) click(p *hclient.Poll, option int) {
	if k.OnVote == nil || !k.Busy.CompareAndSwap(false, true) {
		return
	}
	k.OnVote(chat.PollAfterClick(p, resultsOf(p).Mine, option))
}

func (k *Card) drawView(c *widget.Context, s Source, r geom.Rect) {
	ink := c.Theme.Accent
	if c.Hovered(r) {
		ink = c.Theme.AccentHover
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			c.OpenModal(NewVotes(s.Poll, s.Members))
		}
	}
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
	label := c.T("poll.view_votes")
	c.Paint.Text(label, r.X+(r.W-c.Paint.TextWidth(label, viewStyle))/2, r.Y+c.Hairline()+viewPadTop, bodyLine, viewStyle, ink)
}

func itoa(n int) string { return strconv.Itoa(n) }
