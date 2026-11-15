package channels

import (
	"context"
	"strconv"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	pinStripH      = 43
	pinStripGap    = 8
	pinStripPad    = 4
	pinStripRadius = 6
	pinLinePadY    = 4
	pinLinePadX    = 6.4
	pinLineRadius  = 5
	pinLineGap     = 6.4
	pinLineHover   = 0.08
	pinLineAlpha   = 0.8
	pinMarkAlpha   = 0.7
	pinMark        = "\U0001F4CC"
)

var (
	pinLineName = paint.TextStyle{Size: 13.6, Weight: paint.Bold}
	pinLineText = paint.TextStyle{Size: 13.6, Weight: paint.Regular}
)

// pinsPanel is what is pinned in the open channel: the strip under the header and the list behind the pin in it.
type pinsPanel struct {
	sheet  sheet
	column cardColumn
	more   widget.Button
	moreAt geom.Rect
	src    []hclient.ChatMessage
	built  float32
	avail  float32
	zoom   float32
	names  int

	c     *widget.Context
	s     *Screen
	model model
	pins  []hclient.ChatMessage
}

// pinStripSpace is the room the strip takes above the log: none when nothing is pinned.
func pinStripSpace(pins []hclient.ChatMessage) float32 {
	if len(pins) == 0 {
		return 0
	}
	return pinStripH + pinStripGap
}

func sameSlice(a, b []hclient.ChatMessage) bool {
	return len(a) == len(b) && (len(a) == 0 || &a[0] == &b[0])
}

// fit makes the cards again when the pins, the room for them or the zoom changed.
func (p *pinsPanel) fit(avail float32) {
	c, s, m := p.c, p.s, p.model
	full := min(sheetWidth, c.Viewport.W-2*sheetMargin) - 2*(c.Hairline()+listPad)
	if sameSlice(p.src, p.pins) && p.built == full && p.avail == avail && p.zoom == c.Paint.Zoom && p.names == len(m.state.Members) {
		return
	}
	p.src, p.built, p.avail, p.zoom, p.names = p.pins, full, avail, c.Paint.Zoom, len(m.state.Members)
	p.column.screen, p.column.empty = s, c.T("app.no_pinned_messages")
	p.column.layout(c, avail, full, func(width float32) {
		p.column.items = p.column.items[:0]
		for _, pin := range p.pins {
			card := s.newCard(c, m, pin, "", width, false)
			id, channel, thread := pin.ID, pin.ChannelID, pin.Thread()
			card.jump = func() { p.sheet.Close(); s.goToThread(channel, id, thread) }
			if s.chatFeed().CanPin() {
				card.action = func() { s.pin(id, false) }
			}
			p.column.items = append(p.column.items, colItem{card: card})
		}
	})
}

func (s *Screen) pin(id int, on bool) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		s.fail(s.chatFeed().Pin(ctx, id, on))
	}()
}

// drawPins draws the strip and the list for the open channel; button is the pin in the header.
func (s *Screen) drawPins(c *widget.Context, m model, button, strip geom.Rect, pins []hclient.ChatMessage) {
	p := &s.chat.find.pins
	p.c, p.s, p.model, p.pins = c, s, m, pins
	if p.sheet.fit == nil {
		p.sheet.fit = p.fit
	}
	p.sheet.anchor, p.sheet.extra = button, geom.Rect{}
	p.sheet.title, p.sheet.icon, p.sheet.dim = c.T("app.pinned_messages"), "push-pin", true
	p.sheet.minimum, p.sheet.column = sheetMinHeight, &p.column

	if len(pins) > 0 {
		s.drawPinStrip(c, m, strip, pins)
		p.sheet.extra = strip
	}
	p.sheet.show(c)
}

func (s *Screen) drawPinStrip(c *widget.Context, m model, r geom.Rect, pins []hclient.ChatMessage) {
	p := &s.chat.find.pins
	edge := c.Hairline()
	c.Paint.Stroke(r, pinStripRadius, edge, theme.WithAlpha(c.Theme.Tint, mcEdge))
	inner := r.InsetAll(edge + pinStripPad)

	right := inner.Right()
	if len(pins) > 1 {
		p.more.Label = c.T("app.all_pinned", "count", strconv.Itoa(len(pins)))
		p.more.Variant, p.more.Small = widget.Ghost, true
		size := p.more.Measure(c, 0)
		at := geom.Rect{X: inner.Right() - size.W, Y: inner.Y + (inner.H-size.H)/2, W: size.W, H: size.H}
		p.moreAt = at
		if p.more.OnClick == nil {
			p.more.OnClick = func() {
				p.sheet.from = p.moreAt
				p.sheet.Toggle()
			}
		}
		p.more.Draw(c, at)
		right -= size.W + pinStripPad
	}
	latest := pins[0]
	line := geom.Rect{X: inner.X, Y: inner.Y + (inner.H-(pinLinePadY*2+13.6*1.5))/2, W: right - inner.X, H: pinLinePadY*2 + 13.6*1.5}
	hovered := c.Hovered(line)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(line, pinLineRadius, theme.WithAlpha(c.Theme.Tint, pinLineHover))
		if c.Clicked(line) {
			c.Claim()
			s.goToThread(latest.ChannelID, latest.ID, latest.Thread())
		}
	}
	x := line.X + pinLinePadX
	lh := float32(13.6 * 1.5)
	top := line.Y + pinLinePadY
	c.Paint.Text(pinMark, x, top, lh, pinLineText, theme.WithAlpha(c.Theme.Text, pinMarkAlpha))
	x += c.Paint.TextWidth(pinMark, pinLineText) + pinLineGap
	who := s.nameOf(m, latest.UserID, latest.Nickname)
	c.Paint.Text(who, x, top, lh, pinLineName, c.Theme.Text)
	x += c.Paint.TextWidth(who, pinLineName) + pinLineGap
	text := strings.ReplaceAll(latest.Body, "\n", " ")
	if text == "" {
		text = latest.AttachmentName
	}
	if text == "" {
		text = c.T("app.attachment_2")
	}
	c.Paint.Text(elide(c, text, pinLineText, line.Right()-pinLinePadX-x), x, top, lh, pinLineText, theme.WithAlpha(c.Theme.Text, pinLineAlpha))
}

// elide cuts text that is wider than w short, with an ellipsis in place of the rest.
func elide(c *widget.Context, text string, style paint.TextStyle, w float32) string {
	if c.Paint.TextWidth(text, style) <= w {
		return text
	}
	runes := []rune(text)
	lo, hi := 0, len(runes)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if c.Paint.TextWidth(string(runes[:mid])+"…", style) <= w {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return string(runes[:lo]) + "…"
}
