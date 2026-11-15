package channels

import (
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	threadTitleSize  = 25.6
	threadTitleLine  = 30.72
	threadTitleTop   = 3.2
	threadTitleBot   = 16.3
	threadDividerTop = 9.6
	threadDividerBot = 12.8
	threadDividerSz  = 12.48
	threadDividerGap = 11.2
	opGap            = 4.8
	opPadX           = 5.6
	opSize           = 10.4
	opHeight         = 13
	opRadius         = 4
	opAlpha          = 0.25
	opSpacing        = opSize * 0.04
	threadSearchMin  = 150
)

var (
	threadTitleStyle   = paint.TextStyle{Size: threadTitleSize, Weight: paint.Bold}
	threadDividerStyle = paint.TextStyle{Size: threadDividerSz, Weight: paint.Regular}
	opStyle            = paint.TextStyle{Size: opSize, Weight: paint.Bold, Spacing: opSpacing}
)

// postBlocks is the room a thread's first message makes for its title above it and the line under it.
func (s *Screen) postBlocks(c *widget.Context, msg *hclient.ChatMessage, bodyW float32) (lead, tail float32) {
	if msg.Title == "" {
		return 0, 0
	}
	lines := s.threadTitleLines(c, msg.Title, bodyW)
	lead = threadTitleTop + float32(len(lines))*threadTitleLine + threadTitleBot
	tail = threadDividerTop + threadDividerSz*1.5 + threadDividerBot
	return lead, tail
}

// threadTitleLines breaks the open post's title into lines; the last answer is kept while the width stays.
func (s *Screen) threadTitleLines(c *widget.Context, title string, bodyW float32) []string {
	memo := &s.forum.titleLines
	if memo.lines == nil || memo.text != title || memo.width != bodyW || memo.zoom != c.Paint.Zoom {
		*memo = titleMemo{text: title, width: bodyW, zoom: c.Paint.Zoom, lines: wrapText(c, title, threadTitleStyle, s.threadTitleWidth(bodyW), 0, 0)}
	}
	return memo.lines
}

// threadTitleWidth is the width the title has, given the width a message's words have.
func (s *Screen) threadTitleWidth(bodyW float32) float32 {
	return bodyW + msgPadX + msgAvatar + msgGapX - msgPadX
}

func (s *Screen) drawPostLead(c *widget.Context, msg *hclient.ChatMessage, x, y, w float32) {
	lines := s.threadTitleLines(c, msg.Title, bodyWidth(w))
	for i, line := range lines {
		c.Paint.Text(line, x, y+threadTitleTop+float32(i)*threadTitleLine, threadTitleLine, threadTitleStyle, c.Theme.Text)
	}
}

func (s *Screen) drawPostTail(c *widget.Context, x, y, w float32, empty bool) {
	key := "forum.answers"
	if empty {
		key = "forum.no_answers"
	}
	text := c.T(key)
	tw := c.Paint.TextWidth(text, threadDividerStyle)
	mid := y + threadDividerTop + threadDividerSz*1.5/2
	right := x + w - logGutter
	centre := x + (right-x)/2
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: x, Y: mid, W: centre - tw/2 - threadDividerGap - x, H: edge}, 0, c.Theme.Border)
	c.Paint.Fill(geom.Rect{X: centre + tw/2 + threadDividerGap, Y: mid, W: right - (centre + tw/2 + threadDividerGap), H: edge}, 0, c.Theme.Border)
	c.Paint.Text(text, centre-tw/2, y+threadDividerTop, threadDividerSz*1.5, threadDividerStyle, c.Theme.Muted)
}

// drawOPBadge marks whoever started the open post, beside their name; it returns how far the time moves right.
func (s *Screen) drawOPBadge(c *widget.Context, msg *hclient.ChatMessage, x, y float32) float32 {
	if s.chat.channel >= 0 || s.forum.author != msg.UserID {
		return 0
	}
	label := c.T("forum.op")
	w := c.Paint.TextWidth(label, opStyle) + 2*opPadX
	box := geom.Rect{X: x + opGap, Y: y + (msgHead-opHeight)/2 + 0.6, W: w, H: opHeight}
	c.Paint.Fill(box, opRadius, theme.WithAlpha(c.Theme.Accent, opAlpha))
	c.Paint.Text(label, box.X+opPadX, box.Y+(opHeight-opSize*1.5)/2, opSize*1.5, opStyle, c.Theme.Accent)
	return opGap + w + msgWhenGap
}

func (s *Screen) drawThreadHead(c *widget.Context, m model, r geom.Rect, name string) {
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y + chatHeadH - edge, W: r.W, H: edge}, 0, c.Theme.Border)
	closer := widget.Button{Icon: "x", Variant: widget.Ghost, Small: true, OnClick: s.closePost}
	size := closer.Measure(c, 0)
	closer.Draw(c, geom.Rect{X: r.X, Y: r.Y + (chatHeadBox-size.H)/2, W: size.W, H: size.H})
	x := r.X + size.W + chatHeadGap
	title := widget.Upper(name)
	tw := min(c.Paint.TextWidth(title, headStyle), max(0, r.W-2*size.W-4*chatHeadGap-size.W-threadSearchMin))
	c.Paint.TextIn(geom.Rect{X: x, Y: r.Y, W: tw, H: chatHeadBox}, title, x, r.Y+(chatHeadBox-headLine)/2, headLine, headStyle, theme.WithAlpha(c.Theme.Text, 0.7))
	s.drawFinderHead(c, m, r, size.W+chatHeadGap+tw)
}

// canPin says whether the pin on a message is offered: the pin of a post is its own right.
func (s *Screen) canPin(msg *hclient.ChatMessage) bool {
	if msg.Title != "" {
		return s.Session.Chat().CanPinPosts()
	}
	return s.chatFeed().CanPin()
}

func (s *Screen) mayDeletePost(msg *hclient.ChatMessage) bool {
	return msg.Title != "" && s.Session.Chat().CanDeletePosts()
}
