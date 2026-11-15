package channels

import (
	"context"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/dm"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	dmDialogWidth  = 480
	keyBoxPadY     = 12.8
	keyBoxPadX     = 14.4
	keyBoxRadius   = 8
	keyBoxSize     = 16.8
	keyBoxSafety   = 19.2
	keyBoxLine     = 1.5
	keyBoxSpacing  = 0.04
	keyBoxDash     = 3
	keyBoxDashGap  = 2
	unlockErrorTop = 6.4
)

// keyBox shows a key or a number to be read or copied: monospaced, centred and broken where it has dashes or spaces.
type keyBox struct {
	text string
	size float32
}

func (k keyBox) style() paint.TextStyle {
	return paint.TextStyle{Size: k.size, Weight: paint.Regular, Mono: true, Spacing: k.size * keyBoxSpacing}
}

func (k keyBox) lines(c *widget.Context, width float32) []string {
	var lines []string
	line, piece := "", ""
	flush := func() {
		if line != "" && c.Paint.TextWidth(line+piece, k.style()) > width {
			lines = append(lines, strings.TrimRight(line, " "))
			line = ""
		}
		line += piece
		piece = ""
	}
	for _, r := range k.text {
		piece += string(r)
		if r == '-' || r == ' ' {
			flush()
		}
	}
	flush()
	return append(lines, strings.TrimRight(line, " "))
}

func (k keyBox) Measure(c *widget.Context, w float32) geom.Size {
	edge := c.Hairline()
	n := len(k.lines(c, w-2*(keyBoxPadX+edge)))
	return geom.Size{W: w, H: 2*(keyBoxPadY+edge) + float32(n)*k.size*keyBoxLine}
}

func (k keyBox) Draw(c *widget.Context, r geom.Rect) {
	edge := c.Hairline()
	c.Paint.Fill(r, keyBoxRadius, c.Theme.Bg)
	c.Paint.DashedRoundRect(r, keyBoxRadius, edge, keyBoxDash, keyBoxDashGap, c.Theme.BorderStrong)
	line := k.size * keyBoxLine
	y := r.Y + edge + keyBoxPadY
	for _, text := range k.lines(c, r.W-2*(keyBoxPadX+edge)) {
		c.Paint.Text(text, r.X+(r.W-c.Paint.TextWidth(text, k.style()))/2, y, line, k.style(), c.Theme.Text)
		y += line
	}
}

func (s *Screen) later(c *widget.Context) *widget.Button {
	return &widget.Button{Label: c.T("dm.keys.later"), Variant: widget.Ghost, OnClick: c.CloseModal}
}

// showRecoveryKey is the key to this account's private messages, shown once so it can be kept. first says it is the first time.
func (s *Screen) showRecoveryKey(c *widget.Context, first bool) {
	session := s.Session.DM()
	shown := session.RecoveryKey()
	if shown == "" {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
			defer cancel()
			key, err := session.NewRecoveryKey(ctx)
			if err != nil {
				s.fail(s.dm.feed.words(err))
				return
			}
			c.Post(func() { s.openRecoveryKey(c, key, false) })
		}()
		return
	}
	s.openRecoveryKey(c, shown, first)
}

func (s *Screen) openRecoveryKey(c *widget.Context, key string, first bool) {
	session := s.Session.DM()
	text := c.T("dm.keys.setup_text_new")
	if first {
		text = c.T("dm.keys.setup_text")
	}
	copyButton := &widget.Button{Label: c.T("dm.keys.copy"), Icon: "copy", Variant: widget.Ghost}
	copyButton.OnClick = func() {
		rl.SetClipboardText(key)
		copyButton.Label = c.T("dm.keys.copied")
	}
	saved := &widget.Button{Label: c.T("dm.keys.saved"), Variant: widget.Primary, OnClick: func() {
		session.MarkBackedUp()
		c.CloseModal()
	}}
	c.OpenModal(&widget.Prompt{
		Title: c.T("dm.keys.setup_title"), Text: text, Width: dmDialogWidth, OnCancel: c.CloseModal,
		Body: keyBox{text: key, size: keyBoxSize}, Buttons: []*widget.Button{copyButton, s.later(c), saved},
	})
}

// unlockBody is the box a recovery key is typed into, with what was wrong with the last try.
type unlockBody struct {
	field widget.TextField
	err   string
}

func (u *unlockBody) Measure(c *widget.Context, w float32) geom.Size {
	h := u.field.Measure(c, w).H
	if u.err != "" {
		h += unlockErrorTop + dmNoteTextLine
	}
	return geom.Size{W: w, H: h}
}

func (u *unlockBody) Draw(c *widget.Context, r geom.Rect) {
	h := u.field.Measure(c, r.W).H
	u.field.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: h})
	if u.err != "" {
		c.Paint.Text(u.err, r.X, r.Y+h+unlockErrorTop, dmNoteTextLine, dmNoteStyle, c.Theme.Danger)
	}
}

// showUnlock asks for the recovery key that opens this account's private messages on this computer.
func (s *Screen) showUnlock(c *widget.Context) {
	session := s.Session.DM()
	body := &unlockBody{}
	body.field.Inset = true
	body.field.Placeholder = c.T("dm.keys.unlock_placeholder")
	body.field.RequestFocus()
	prompt := &widget.Prompt{Title: c.T("dm.keys.unlock_title"), Text: c.T("dm.keys.unlock_text"), Width: dmDialogWidth, OnCancel: c.CloseModal, Body: body}
	unlock := func() {
		if prompt.Busy {
			return
		}
		prompt.Busy, body.err = true, ""
		typed := body.field.Value
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
			defer cancel()
			ok, err := session.Unlock(ctx, typed)
			c.Post(func() {
				prompt.Busy = false
				switch {
				case err != nil:
					body.err = s.dm.feed.words(err).Error()
				case !ok:
					body.err = c.T("dm.keys.wrong")
				default:
					c.CloseModal()
				}
			})
		}()
	}
	body.field.OnEnter = unlock
	lost := &widget.Button{Label: c.T("dm.keys.lost"), Variant: widget.Ghost, OnClick: func() { s.confirmStartOver(c) }}
	prompt.Buttons = []*widget.Button{lost, s.later(c), {Label: c.T("dm.keys.unlock"), Variant: widget.Primary, OnClick: unlock}}
	c.OpenModal(prompt)
}

func (s *Screen) confirmStartOver(c *widget.Context) {
	session := s.Session.DM()
	s.confirm(c, c.T("dm.keys.start_over_title"), c.T("dm.keys.start_over_text"), c.T("dm.keys.start_over"), func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
			defer cancel()
			status := session.StartOver(ctx)
			c.Post(func() {
				if status.State == dm.Ready && status.NeedsBackup {
					s.showRecoveryKey(c, true)
				}
			})
		}()
	})
}

// showSafety is the number to read out loud, the same on both screens exactly when nobody is in between.
func (s *Screen) showSafety(c *widget.Context, m model, user int) {
	session := s.Session.DM()
	number := session.SafetyNumber(user)
	if number == "" {
		return
	}
	name := s.nameOf(m, user, c.T("reactions.someone"))
	verified := session.Trust(user).Verified
	toggle := &widget.Button{Label: c.T("dm.safety.verify"), Variant: widget.Primary, OnClick: func() {
		session.SetVerified(user, !verified)
		c.CloseModal()
	}}
	if verified {
		toggle.Label, toggle.Variant = c.T("dm.safety.unverify"), widget.Ghost
	}
	closeButton := &widget.Button{Label: c.T("dm.close"), Variant: widget.Ghost, OnClick: c.CloseModal}
	c.OpenModal(&widget.Prompt{
		Title: c.T("dm.safety.title", "name", name), Text: c.T("dm.safety.text", "name", name), Width: dmDialogWidth, OnCancel: c.CloseModal,
		Body: keyBox{text: number, size: keyBoxSafety}, Buttons: []*widget.Button{closeButton, toggle},
	})
}

// confirm asks whether to go on with something that cannot be taken back.
func (s *Screen) confirm(c *widget.Context, title, text, ok string, run func()) {
	c.OpenModal(&widget.Prompt{
		Title: title, Text: text, OK: ok, Cancel: c.T("app.cancel"), OnCancel: c.CloseModal,
		OnSubmit: func([]string) {
			c.CloseModal()
			run()
		},
	})
}

func (s *Screen) confirmDelete(id int) {
	c := s.dm.c
	s.confirm(c, c.T("app.delete_this_message"), "", c.T("app.delete_2"), func() {
		s.dmDo(func(ctx context.Context) error { return s.dm.feed.Delete(ctx, id) })
	})
}

func (s *Screen) clearConversation(c *widget.Context, id int, name string) {
	session := s.Session.DM()
	s.confirm(c, c.T("dm.clear.title"), c.T("dm.clear.text", "name", name), c.T("dm.clear.ok"), func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
			defer cancel()
			err := session.Clear(ctx, id)
			c.Post(func() {
				s.fail(s.dm.feed.words(err))
				if err == nil && s.dm.current == id {
					s.closeConversation()
				}
			})
		}()
	})
}

// openWith opens the conversation with somebody, made if there is none, on the page of private messages.
func (s *Screen) openWith(c *widget.Context, user int) {
	session := s.Session.DM()
	s.ensureFeed(c)
	status := session.Status()
	switch status.State {
	case dm.Locked:
		s.showUnlock(c)
		return
	case dm.Ready:
	default:
		if !s.dm.page {
			s.TogglePrivate()
		}
		return
	}
	if status.NeedsBackup {
		s.showRecoveryKey(c, true)
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
		defer cancel()
		id, err := session.Open(ctx, user)
		c.Post(func() {
			if err != nil {
				s.fail(s.dm.feed.words(err))
				return
			}
			s.openConversation(id)
		})
	}()
}
