package channels

import (
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	dividerAbove   = 12.3
	dividerBelow   = 6.9
	dividerMargin  = 8
	dividerSize    = 10.88
	dividerLine    = dividerSize * 1.3
	dividerPadX    = 8
	dividerPadY    = 0.8
	dividerSpacing = dividerSize * 0.03
	newsContext    = 90
	newsMaxLoaded  = 1500
	mentionAlpha   = 0.07
	mentionBar     = 3
)

var dividerStyle = paint.TextStyle{Size: dividerSize, Weight: paint.Bold, Spacing: dividerSpacing}

// newsMark is where the unread messages of the open channel begin, taken when it was opened.
type newsMark struct {
	after   int
	jumping bool
	top     float32
}

// openNews notes where the news begins in a channel being opened, and tells the store it is the one on screen.
func (s *Screen) openNews(id int) {
	store := s.chatFeed()
	s.chat.news = newsMark{}
	if mark := store.Unread(id); mark.Unread > 0 {
		s.chat.news = newsMark{after: mark.LastReadID, jumping: true}
	}
	store.SetOpen(id)
}

// dividerAt is the index of the first message newer than what was read, or -1.
func (n *newsMark) dividerAt(entries []*chat.Entry) int {
	if n.after == 0 && !n.jumping {
		return -1
	}
	for i, e := range entries {
		if e.Msg.ID > n.after {
			return i
		}
	}
	return -1
}

// jumpToNews puts the divider near the top of the log once the history back to it is loaded.
func (s *Screen) jumpToNews(total, logH float32, entries []*chat.Entry, more, loading bool) {
	st := &s.chat
	if !st.news.jumping || len(entries) == 0 {
		return
	}
	reached := entries[0].Msg.ID <= st.news.after || !more || len(entries) > newsMaxLoaded
	if !reached {
		if !loading {
			s.chatFeed().LoadOlder(st.channel)
		}
		return
	}
	st.news.jumping = false
	if st.news.top > 0 {
		st.offset = min(max(total-logH-(st.news.top-newsContext), 0), max(0, total-logH))
	}
}

func (s *Screen) drawDivider(c *widget.Context, log geom.Rect, y float32) {
	left, right := log.X+dividerMargin, log.Right()-logGutter-dividerMargin
	c.Paint.Fill(geom.Rect{X: left, Y: y, W: right - left, H: c.Hairline()}, 0, theme.NewMessages)
	label := strings.ToUpper(c.T("chat.new_messages"))
	w := c.Paint.TextWidth(label, dividerStyle) + 2*dividerPadX
	h := float32(dividerLine + 2*dividerPadY)
	pill := geom.Rect{X: right - w, Y: y - h/2, W: w, H: h}
	c.Paint.Fill(pill, h/2, theme.NewMessages)
	c.Paint.Text(label, pill.X+dividerPadX, pill.Y+dividerPadY, dividerLine, dividerStyle, rl.White)
}

// drawHighlight lights a message that is addressed to you.
func (s *Screen) drawHighlight(c *widget.Context, bounds geom.Rect, msg *hclient.ChatMessage, me hclient.User) {
	if s.chat.dm || !chat.Highlights(*msg, me) {
		return
	}
	c.Paint.Fill(bounds, rowRadiusMsg, theme.WithAlpha(c.Theme.Warn, mentionAlpha))
	c.Paint.PushClip(geom.Rect{X: bounds.X, Y: bounds.Y, W: mentionBar, H: bounds.H})
	c.Paint.Fill(bounds, rowRadiusMsg, c.Theme.Warn)
	c.Paint.PopClip()
}
