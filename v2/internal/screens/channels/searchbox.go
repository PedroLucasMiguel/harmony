package channels

import (
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	searchLeft    = 27.2
	searchRight   = 25.6
	searchTyping  = 40
	searchChipGap = 4.8
	clearSize     = 24
	clearInset    = 5.6
	clearGlyph    = 14
	clearAlpha    = 0.6
)

// drawClear paints the cross at the right end of a search box and says whether it was pressed.
func drawClear(c *widget.Context, box geom.Rect) bool {
	btn := geom.Rect{X: box.Right() - clearInset - clearSize, Y: box.Y + (box.H-clearSize)/2, W: clearSize, H: clearSize}
	hovered := c.Hovered(btn)
	alpha := float32(clearAlpha)
	if hovered {
		alpha = 1
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(btn, clearSize/2, theme.WithAlpha(c.Theme.Tint, 0.1))
	}
	c.Paint.Icon("x", geom.Rect{X: btn.X + (clearSize-clearGlyph)/2, Y: btn.Y + (clearSize-clearGlyph)/2, W: clearGlyph, H: clearGlyph}, theme.WithAlpha(c.Theme.Text, alpha))
	if hovered && c.In.Pressed {
		c.Claim()
		return true
	}
	return false
}

// drawFinderHead draws what the chat header holds after the channel's name: the search, the pins and the stars.
func (s *Screen) drawFinderHead(c *widget.Context, m model, r geom.Rect, titleWidth float32) {
	f := &s.chat.find
	f.c = c
	f.setScope(s.Server.URL, m.state.Me.ID)
	s.escapeFinder(c)
	if !f.wired {
		f.wired = true
		f.pinsButton = widget.Button{Icon: "push-pin", Variant: widget.Ghost, Small: true, OnClick: func() {
			f.pins.sheet.from = geom.Rect{}
			f.pins.sheet.Toggle()
		}}
		f.starsButton = widget.Button{Icon: "star", Variant: widget.Ghost, Small: true, OnClick: func() {
			if f.stars.sheet.open {
				f.stars.sheet.Close()
			} else {
				f.stars.open()
			}
		}}
		f.search.field.OnEnter = s.enterSearch
		f.search.pop.active = -1
	}
	if f.channel != s.chat.channel {
		f.channel = s.chat.channel
		f.pins.sheet.Close()
		f.stars.sheet.Close()
	}
	f.pinsButton.Active, f.starsButton.Active = f.pins.sheet.open, f.stars.sheet.open

	size := f.pinsButton.Measure(c, 0)
	y := r.Y + (chatHeadBox-size.H)/2
	right := r.Right()
	starsAt := geom.Rect{X: right - size.W, Y: y, W: size.W, H: size.H}
	right = starsAt.X - chatHeadGap
	pinsAt := geom.Rect{X: right - size.W, Y: y, W: size.W, H: size.H}
	right = pinsAt.X - chatHeadGap
	f.starsButton.Draw(c, starsAt)
	f.pinsButton.Draw(c, pinsAt)

	x := r.X + titleWidth + chatHeadGap
	box := geom.Rect{X: x, Y: r.Y, W: max(0, right-x), H: chatHeadBox}
	s.drawSearchBox(c, m, box)

	pins := s.chatFeed().Pinned(s.chat.channel)
	strip := geom.Rect{X: r.X, Y: r.Y + chatHeadH + chatLogGap, W: r.W, H: pinStripH}
	s.drawPins(c, m, pinsAt, strip, pins)
	s.drawStars(c, m, starsAt)
	s.drawResults(c, m, r)
	f.search.pop.show(c, s, box)
}

func (s *Screen) enterSearch() {
	q := &s.chat.find.search
	if row := q.pop.rowAt(q.pop.active); q.pop.open && row != nil {
		row.choose()
		return
	}
	s.submitSearch()
}

func (s *Screen) drawSearchBox(c *widget.Context, m model, box geom.Rect) {
	q := &s.chat.find.search
	q.model = m
	focused := q.field.Focused(c)
	if focused {
		switch {
		case c.In.KeyDown, c.In.KeyUp:
			if !q.pop.open {
				s.refreshPop(m)
			}
			step := 1
			if c.In.KeyUp {
				step = -1
			}
			q.pop.step(step)
		case c.In.Backspace && q.field.Value == "" && len(q.chips) > 0:
			q.removeChip(len(q.chips) - 1)
			q.pop.dirty = true
			s.searchNow()
		}
	}
	if focused && !q.had {
		q.pop.dirty = true
	}
	q.had = focused

	edge := c.Hairline()
	room := box.W - searchLeft - searchRight - searchTyping
	shown, used := 0, float32(0)
	for _, chip := range q.chips {
		w := (widget.FilterChip{Key: chip.key + ":", Value: chip.label}).Measure(c).W
		if used+w > room {
			break
		}
		used += w + searchChipGap
		shown++
	}
	q.field.Box, q.field.Lead = true, used
	if title := s.serverTitle(); q.hintFor != c.Strings || q.hintTitle != title {
		q.hintFor, q.hintTitle, q.hint = c.Strings, title, c.T("search.placeholder_in", "name", title)
	}
	q.field.Placeholder = q.hint
	if s.chat.channel < 0 {
		q.field.Placeholder = s.forum.searchHint
	}
	if len(q.chips) > 0 {
		q.field.Placeholder = ""
	}
	q.field.Draw(c, box)

	x := box.X + edge + searchLeft
	for i := 0; i < shown; i++ {
		chip := q.chips[i]
		fc := widget.FilterChip{Key: chip.key + ":", Value: chip.label}
		size := fc.Measure(c)
		if fc.Show(c, geom.Rect{X: x, Y: box.Y + (box.H-size.H)/2, W: size.W, H: size.H}) {
			q.removeChip(i)
			q.pop.dirty = true
			q.field.RequestFocus()
			s.searchNow()
			break
		}
		x += size.W + searchChipGap
	}
	if (q.field.Value != "" || len(q.chips) > 0 || q.open) && drawClear(c, box) {
		q.clearAll()
		q.field.RequestFocus()
	}

	if q.field.Value != q.typed {
		q.typed = q.field.Value
		had := len(q.chips)
		if strings.HasSuffix(q.typed, " ") && q.absorbTokens(m) {
			q.typed = q.field.Value
		}
		q.pop.dirty = true
		if len(q.chips) != had {
			s.searchNow()
		}
	}
	if q.pop.dirty {
		if focused || q.pop.open {
			s.refreshPop(m)
		}
		q.pop.dirty = false
	}
}

// escapeFinder takes Escape for the topmost thing the header opened: the list under the search box, the answers, the stars, the pins.
func (s *Screen) escapeFinder(c *widget.Context) {
	if !c.EscapeBase() {
		return
	}
	f := &s.chat.find
	q := &f.search
	switch {
	case q.pop.open:
		q.pop.close()
	case q.open:
		q.closeResults()
	case f.stars.sheet.open:
		if f.stars.query.Value != "" && f.stars.query.Focused(c) {
			f.stars.query.SetValue("")
		} else {
			f.stars.sheet.Close()
		}
	case f.pins.sheet.open:
		f.pins.sheet.Close()
	case q.field.Focused(c):
		q.field.Blur(c)
	default:
		return
	}
	c.In.Escape = false
}
