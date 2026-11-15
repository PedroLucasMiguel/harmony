package channels

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	pendingRadius  = 8
	pendingFill    = 0.07
	pendingMarginT = 2.4
	pendingMarginB = 6.4
	pendingMarginX = 1.6
	pendingMax     = 208
	removeSize     = 24
	removeInset    = 4
	uploadFootGap  = 4.8
	uploadPadBot   = 7.2
	uploadNameSize = 13.12
)

func (s *Screen) hasPending() bool { return len(s.chat.files) > 0 }

func (s *Screen) uploading() bool { return s.chat.sending != nil && !s.chat.sending.Done.Load() }

func (s *Screen) replyBarHeight() float32 {
	if s.chat.reply == nil && s.chat.editing == nil {
		return 0
	}
	return replyBarPadTop + replyBarBtn + replyBarPadBot + 1 + replyBarMargin
}

func (s *Screen) pendingHeight(inner float32) float32 {
	if !s.hasPending() {
		return 0
	}
	perRow := max(1, int((inner-2*pendingMarginX+pendingGap)/(pendingW+pendingGap)))
	rows := (len(s.chat.files) + perRow - 1) / perRow
	h := float32(rows)*(pendingPic+pendingMeta) + float32(rows-1)*pendingGap
	return min(h, pendingMax) + pendingMarginT + pendingMarginB
}

func (s *Screen) uploadHeight() float32 {
	if !s.uploading() {
		return 0
	}
	return pendingMarginT + uploadPad + uploadHead + uploadFootGap + uploadBar + uploadPadBot + pendingMarginB/2
}

func (s *Screen) composerHeight(c *widget.Context, w float32) float32 {
	edge := c.Hairline()
	inner := w - 2*(edge+composerPadX)
	area := s.chat.input.Measure(c, inner-4*composerBtn-4*composerGap).H
	if s.recording() {
		area = composerBtn
	}
	return 2*(edge+composerPadY) + s.replyBarHeight() + s.pendingHeight(inner) + s.uploadHeight() + max(composerBtn, area)
}

func (s *Screen) drawComposer(c *widget.Context, m model, r geom.Rect, channel string) {
	st := &s.chat
	if st.sending != nil && st.sending.Done.Load() {
		if err, _ := st.sending.Err.Load().(error); err != nil {
			s.fail(err)
		}
		st.sending = nil
	}
	edge := c.Hairline()
	border := c.Theme.Border
	if (st.input.Focused(c) && !s.recording()) || st.editing != nil {
		border = c.Theme.Accent
	}
	c.Paint.Fill(r, composerRadius, c.Theme.Surface2)
	if st.editing != nil {
		c.Paint.Stroke(r.InsetAll(-1), composerRadius+1, 1, theme.WithAlpha(c.Theme.Accent, 0.45))
	}
	c.Paint.Stroke(r, composerRadius, edge, border)
	inner := geom.Rect{X: r.X + edge + composerPadX, Y: r.Y + edge + composerPadY, W: r.W - 2*(edge+composerPadX), H: r.H - 2*(edge+composerPadY)}
	y := inner.Y
	if bar := s.replyBarHeight(); bar > 0 {
		s.drawReplyBar(c, m, geom.Rect{X: inner.X, Y: y, W: inner.W, H: bar})
		y += bar
	}
	if h := s.pendingHeight(inner.W); h > 0 {
		s.drawPending(c, geom.Rect{X: inner.X + pendingMarginX, Y: y + pendingMarginT, W: inner.W - 2*pendingMarginX, H: h - pendingMarginT - pendingMarginB})
		y += h
	}
	if h := s.uploadHeight(); h > 0 {
		s.drawUpload(c, geom.Rect{X: inner.X + pendingMarginX, Y: y + pendingMarginT, W: inner.W - 2*pendingMarginX, H: h - pendingMarginT - pendingMarginB/2})
		y += h
	}
	row := geom.Rect{X: inner.X, Y: y, W: inner.W, H: inner.Bottom() - y}
	s.drawComposerRow(c, m, row)
}

func (s *Screen) drawComposerRow(c *widget.Context, m model, row geom.Rect) {
	st := &s.chat
	if s.recording() {
		s.drawRecorder(c, row)
		return
	}
	bottom := row.Bottom()
	attach := geom.Rect{X: row.X, Y: bottom - composerBtn, W: composerBtn, H: composerBtn}
	s.composerButton(c, attach, "plus-circle", plusIcon, c.Theme.Muted, func() { s.pickFiles(c) })

	right := row.Right()
	ready := strings.TrimSpace(st.input.Value()) != "" || s.hasPending()
	last := geom.Rect{X: right - composerBtn, Y: bottom - composerBtn, W: composerBtn, H: composerBtn}
	if ready {
		s.composerButton(c, last, "paper-plane-right", composerIcon, c.Theme.Accent, s.submit)
	} else {
		s.composerButton(c, last, "microphone", composerIcon, c.Theme.Muted, func() { s.startRecording(c) })
	}
	right = last.X - composerGap
	poll := geom.Rect{X: right - composerBtn, Y: bottom - composerBtn, W: composerBtn, H: composerBtn}
	s.composerButton(c, poll, "chart-bar-horizontal", composerIcon, c.Theme.Muted, func() { s.startPoll(c) })
	right = poll.X - composerGap
	emoji := geom.Rect{X: right - composerBtn, Y: bottom - composerBtn, W: composerBtn, H: composerBtn}
	st.emojiAnchor = emoji
	s.composerButton(c, emoji, "smiley", composerIcon, c.Theme.Muted, st.openEmoji)
	right = emoji.X - composerGap

	x := attach.Right() + composerGap
	box := geom.Rect{X: x, Y: row.Y, W: max(0, right-x), H: row.H}
	s.composerKeys(c, m)
	s.mentionKeys(c)
	st.input.Draw(c, box)
	s.showMentions(c, m, box)
}

func (s *Screen) composerButton(c *widget.Context, r geom.Rect, icon string, size float32, ink rl.Color, do func()) {
	if do != nil && c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, 6, theme.WithAlpha(c.Theme.Tint, 0.12))
		if ink == c.Theme.Muted {
			ink = c.Theme.Text
		}
		if c.Clicked(r) {
			c.Claim()
			do()
		}
	}
	c.Paint.Icon(icon, geom.Rect{X: r.X + (r.W-size)/2, Y: r.Y + (r.H-size)/2, W: size, H: size}, ink)
}

func (s *Screen) pickFiles(c *widget.Context) {
	if s.chat.picking {
		return
	}
	s.chat.picking = true
	title := s.chat.input.Placeholder
	go func() {
		files := filedialog.Pick(title)
		c.Post(func() {
			s.chat.picking = false
			for _, f := range files {
				if info, err := os.Stat(f); err == nil && !info.IsDir() {
					s.chat.files = append(s.chat.files, f)
				}
			}
			s.chat.input.RequestFocus()
		})
	}()
}

func (s *Screen) drawReplyBar(c *widget.Context, m model, r geom.Rect) {
	st := &s.chat
	label, who, accent := c.T("chat_reply.replying_to"), "", false
	if st.reply != nil {
		who = s.nameOf(m, st.reply.UserID, st.reply.Nickname)
	} else {
		label, who, accent = c.T("chat_editing.editing"), "", true
	}
	text := r.X + 6.4
	top := r.Y + replyBarPadTop + (replyBarBtn-replyBarLine)/2
	ink := c.Theme.Muted
	if accent {
		ink = c.Theme.Accent
		c.Paint.Text(label, text, top, replyBarLine, replyBarBold, ink)
		c.Paint.Text(c.T("chat_editing.hint"), text+c.Paint.TextWidth(label+" ", replyBarBold), top, replyBarLine, replyBarStyle, c.Theme.Muted)
	} else {
		c.Paint.Text(label+" ", text, top, replyBarLine, replyBarStyle, ink)
		c.Paint.Text(who, text+c.Paint.TextWidth(label+" ", replyBarStyle), top, replyBarLine, replyBarBold, c.Theme.Text)
	}
	btn := geom.Rect{X: r.Right() - 4 - replyBarBtn, Y: r.Y + replyBarPadTop, W: replyBarBtn, H: replyBarBtn}
	s.composerButton(c, btn, "x", 16, c.Theme.Muted, func() {
		st.reply = nil
		if st.editing != nil {
			s.endEdit()
		}
	})
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Bottom() - replyBarMargin - c.Hairline(), W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
}

func isPicture(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	}
	return false
}

func (s *Screen) drawPending(c *widget.Context, r geom.Rect) {
	st := &s.chat
	perRow := max(1, int((r.W+pendingGap)/(pendingW+pendingGap)))
	c.Paint.PushClip(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: min(r.H, pendingMax)})
	remove := -1
	for i, path := range st.files {
		card := geom.Rect{X: r.X + float32(i%perRow)*(pendingW+pendingGap), Y: r.Y + float32(i/perRow)*(pendingPic+pendingMeta+pendingGap), W: pendingW, H: pendingPic + pendingMeta}
		c.Paint.Fill(card, pendingRadius, theme.WithAlpha(c.Theme.Tint, pendingFill))
		view := geom.Rect{X: card.X, Y: card.Y, W: card.W, H: pendingPic}
		c.Paint.Fill(view, pendingRadius, rl.NewColor(0, 0, 0, 64))
		if isPicture(path) {
			pic := c.Paint.Picture("file:"+path, func() ([]byte, error) { return os.ReadFile(path) })
			c.Paint.DrawPicture(pic, view, pendingRadius, true, theme.Mix(c.Theme.Surface2, c.Theme.Tint, pendingFill))
		} else {
			c.Paint.Icon(s.iconFor(path, ""), geom.Rect{X: view.X + (view.W-41.6)/2, Y: view.Y + (view.H-41.6)/2, W: 41.6, H: 41.6}, theme.WithAlpha(c.Theme.Text, 0.85))
		}
		clip := geom.Rect{X: card.X + 7.2, Y: card.Y + pendingPic, W: card.W - 14.4, H: pendingMeta}
		c.Paint.TextIn(clip, filepath.Base(path), clip.X, clip.Y+4, 18.7, pendingName, c.Theme.Text)
		if info, err := os.Stat(path); err == nil {
			c.Paint.Text(formatBytes(info.Size()), clip.X, clip.Y+4+18.7, 17.3, pendingSize, theme.WithAlpha(c.Theme.Text, 0.6))
		}
		x := geom.Rect{X: card.Right() - removeInset - removeSize, Y: card.Y + removeInset, W: removeSize, H: removeSize}
		c.Paint.Circle(x.X+removeSize/2, x.Y+removeSize/2, removeSize/2, rl.NewColor(0, 0, 0, 153))
		c.Paint.Icon("x", geom.Rect{X: x.X + 5.6, Y: x.Y + 5.6, W: 12.8, H: 12.8}, rl.White)
		if c.Hovered(x) {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.Clicked(x) {
				c.Claim()
				remove = i
			}
		}
	}
	c.Paint.PopClip()
	if remove >= 0 {
		st.files = append(st.files[:remove:remove], st.files[remove+1:]...)
	}
}

func (s *Screen) drawUpload(c *widget.Context, r geom.Rect) {
	op := s.chat.sending
	c.Paint.Fill(r, pendingRadius, theme.WithAlpha(c.Theme.Tint, pendingFill))
	name, _ := op.Name.Load().(string)
	sent, total := op.Sent.Load(), op.Total.Load()
	amount := formatBytes(sent) + " / " + formatBytes(total)
	aw := c.Paint.TextWidth(amount, replyBarStyle)
	x := r.X + 6.4
	top := r.Y + uploadPad + (uploadHead-replyBarLine)/2
	c.Paint.Text(amount, r.Right()-6.4-aw, top, replyBarLine, replyBarStyle, c.Theme.Muted)
	c.Paint.TextIn(geom.Rect{X: x, Y: r.Y, W: max(0, r.W-12.8-aw-8), H: r.H}, name, x, top, replyBarLine, replyBarStyle, c.Theme.Text)
	bar := geom.Rect{X: x, Y: r.Y + uploadPad + uploadHead + uploadFootGap, W: r.W - 12.8, H: uploadBar}
	c.Paint.Fill(bar, uploadBar/2, theme.WithAlpha(c.Theme.Tint, 0.12))
	if total > 0 {
		c.Paint.Fill(geom.Rect{X: bar.X, Y: bar.Y, W: bar.W * float32(sent) / float32(total), H: bar.H}, uploadBar/2, c.Theme.Accent)
	}
}

// save stores a message's file in the downloads folder and says where it went.
func (s *Screen) save(hash, name string) {
	go func() {
		path, err := s.chatFeed().Save(hash, name)
		if err != nil {
			s.fail(err)
			return
		}
		s.say(fmt.Sprintf("Saved to %s", path))
	}()
}
