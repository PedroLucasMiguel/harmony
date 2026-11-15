package channels

import (
	"math"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const (
	dragScrollBase = 160
	dragScrollGain = 6
	dragScrollMax  = 1800
)

// logPick is the selection of text in the log of messages, kept by message id.
type logPick struct {
	sel widget.TextSelection
	c   *widget.Context
}

func rowText(r *row) *widget.RichText {
	l, _ := r.entry.Layout.(*entryLayout)
	if l == nil || l.text == nil || l.text.Height == 0 {
		return nil
	}
	return l.text
}

// drawBody draws a message's text with the part of it that is selected marked.
func (s *Screen) drawBody(c *widget.Context, text *widget.RichText, id int, x, y float32) {
	if sel := &s.chat.pick.sel; sel.Active() {
		from, to := sel.Range(id, math.MaxInt32)
		text.SetSelection(from, to)
	} else {
		text.SetSelection(0, 0)
	}
	text.Draw(c, x, y)
	if click, ok := text.ChipPressed(); ok {
		s.chipPressed(c, s.seen, id, click)
	}
}

func textBounds(t *widget.RichText) geom.Rect {
	x, y := t.Origin()
	return geom.Rect{X: x, Y: y, W: t.Width, H: t.Height}
}

// logSelect lets the pointer select the text of the messages shown and the keys copy it.
func (s *Screen) logSelect(c *widget.Context, log geom.Rect, rows []row, viewTop float32) {
	pick := &s.chat.pick
	pick.c = c
	in := c.In
	s.chat.menu.Show(c)
	s.showNotifiedList(c)
	hovered := c.Hovered(log) && !c.Hovered(s.chat.tools)
	if !c.HasFocus() {
		if in.Copy && pick.sel.Active() {
			rl.SetClipboardText(s.selectedText(c, rows))
		}
		if in.SelectAll && (hovered || pick.sel.Active()) {
			s.selectEverything(c, rows)
		}
	}
	visible := s.visibleText(rows, log, viewTop)
	if in.RightPressed && hovered {
		s.openMessageMenu(c, rows, log, viewTop)
	}
	switch {
	case in.Pressed && hovered && !c.Claimed():
		s.beginPick(c, visible)
	case pick.sel.Dragging():
		if in.Down {
			s.dragPick(c, log, visible)
		} else {
			pick.sel.Release()
		}
	case hovered:
		if t := hitText(c, visible, in.MouseX, in.MouseY); t != nil && t.LinkAt(in.MouseX, in.MouseY) == "" {
			c.SetCursor(rl.MouseCursorIBeam)
		}
	}
}

type shownText struct {
	id   int
	text *widget.RichText
}

func (s *Screen) visibleText(rows []row, log geom.Rect, viewTop float32) []shownText {
	out := s.chat.shown[:0]
	for i := range rows {
		r := &rows[i]
		if r.top+r.height < viewTop {
			continue
		}
		if r.top > viewTop+log.H {
			break
		}
		if t := rowText(r); t != nil {
			out = append(out, shownText{r.entry.Msg.ID, t})
		}
	}
	s.chat.shown = out
	return out
}

func hitText(c *widget.Context, shown []shownText, mx, my float32) *widget.RichText {
	for _, v := range shown {
		if b := textBounds(v.text); my >= b.Y && my < b.Bottom() && mx >= b.X {
			return v.text
		}
	}
	return nil
}

func (s *Screen) beginPick(c *widget.Context, shown []shownText) {
	in := c.In
	for _, v := range shown {
		b := textBounds(v.text)
		if in.MouseY < b.Y || in.MouseY >= b.Bottom() || in.MouseX < b.X {
			continue
		}
		off := v.text.OffsetAt(c, in.MouseX, in.MouseY)
		var from, to int
		switch {
		case in.Clicks == 2:
			from, to = v.text.WordAt(c, off)
		case in.Clicks >= 3:
			from, to = v.text.LineAt(c, off)
		}
		s.chat.pick.sel.Press(v.id, off, in.Clicks, from, to, in.Shift)
		return
	}
	s.chat.pick.sel.Clear()
}

func (s *Screen) dragPick(c *widget.Context, log geom.Rect, shown []shownText) {
	in := c.In
	var best *shownText
	bestD := float32(math.MaxFloat32)
	for i := range shown {
		b := textBounds(shown[i].text)
		d := float32(0)
		switch {
		case in.MouseY < b.Y:
			d = b.Y - in.MouseY
		case in.MouseY >= b.Bottom():
			d = in.MouseY - b.Bottom()
		}
		if d < bestD {
			best, bestD = &shown[i], d
		}
	}
	if best != nil {
		off := best.text.OffsetAt(c, in.MouseX, in.MouseY)
		words, lines := s.chat.pick.sel.Mode()
		var from, to int
		switch {
		case words:
			from, to = best.text.WordAt(c, off)
		case lines:
			from, to = best.text.LineAt(c, off)
		}
		s.chat.pick.sel.Drag(best.id, off, from, to)
	}
	step := func(distance float32) float32 {
		return min(dragScrollBase+dragScrollGain*distance, dragScrollMax) * c.Dt
	}
	switch {
	case in.MouseY < log.Y:
		s.chat.offset += step(log.Y - in.MouseY)
	case in.MouseY > log.Bottom():
		s.chat.offset -= step(in.MouseY - log.Bottom())
	}
}

func (s *Screen) selectEverything(c *widget.Context, rows []row) {
	first, last := -1, -1
	for i := range rows {
		if rowText(&rows[i]) != nil {
			if first < 0 {
				first = rows[i].entry.Msg.ID
			}
			last = rows[i].entry.Msg.ID
		}
	}
	if first >= 0 {
		s.chat.pick.sel.All(first, last, math.MaxInt32)
	}
}

// selectedText is the selected part of each message's text, one message to a line.
func (s *Screen) selectedText(c *widget.Context, rows []row) string {
	sel := &s.chat.pick.sel
	var parts []string
	for i := range rows {
		t := rowText(&rows[i])
		if t == nil {
			continue
		}
		plain := t.Plain(c)
		from, to := sel.Range(rows[i].entry.Msg.ID, len(plain))
		if from < to {
			parts = append(parts, string(plain[from:min(to, len(plain))]))
		}
	}
	return strings.Join(parts, "\n")
}

func (s *Screen) openMessageMenu(c *widget.Context, rows []row, log geom.Rect, viewTop float32) {
	y := c.In.MouseY - log.Y + viewTop
	for i := range rows {
		if y >= rows[i].top && y < rows[i].top+rows[i].height {
			s.messageMenu(c, &rows[i])
			return
		}
	}
}
