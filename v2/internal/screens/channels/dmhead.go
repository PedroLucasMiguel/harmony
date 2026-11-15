package channels

import (
	"context"
	"strconv"
	"time"

	"harmony/v2/internal/dm"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	dmHeadAvatar     = 28.8
	dmHeadAvatarFont = 11.52
	dmHeadGap        = 9.6
	dmHeadNameSize   = 17.6
	dmHeadNameLine   = 21.12
	dmHeadNameMin    = 96
	dmLockSize       = 17.6
	dmLockBox        = 21.1
	dmCountText      = 12.48
	dmVerifiedSize   = 11.2
	dmVerifiedPadX   = 6.4
	dmVerifiedPadY   = 0.8
	dmBannerGap      = 6.4
	dmBannerPadY     = 8
	dmBannerPadX     = 11.2
	dmBannerSize     = 13.6
	dmBannerLine     = 20.4
	dmBannerText     = 224
	dmBannerBorder   = 0.14
	dmBannerFill     = 0.05
	dmBannerRadius   = 8
	dmBannerRowGap   = 8
	dmRequestTimeout = 20 * time.Second
)

var (
	dmHeadNameStyle = paint.TextStyle{Size: dmHeadNameSize, Weight: paint.Semibold}
	dmCountStyleTxt = paint.TextStyle{Size: dmCountText, Weight: paint.Regular}
	dmVerifiedStyle = paint.TextStyle{Size: dmVerifiedSize, Weight: paint.Semibold}
	dmBannerStyle   = paint.TextStyle{Size: dmBannerSize, Weight: paint.Regular}
)

// dmHead is the conversation bar's buttons, made once; what they act on is set by each frame.
type dmHead struct {
	close, menu, members, safety, pins widget.IconButton
	wired                              bool
	c                                  *widget.Context
	m                                  model
	conv                               *dm.Conversation
	name                               string
	menuAt                             geom.Rect
}

func (h *dmHead) wire(s *Screen) {
	if h.wired {
		return
	}
	h.wired = true
	h.close = widget.IconButton{Icon: "x", OnClick: s.closeConversation}
	h.menu = widget.IconButton{Icon: "dots-three-outline-vertical", OnClick: func() { s.openDMMenu(h.c, h.m, h.conv, h.name, h.menuAt) }}
	h.members = widget.IconButton{Icon: "users-three", OnClick: func() { s.showMembers(h.c, h.conv.ID) }}
	h.safety = widget.IconButton{Icon: "shield-check", OnClick: func() { s.showSafety(h.c, h.m, h.conv.Peer) }}
	h.pins = widget.IconButton{Icon: "push-pin", OnClick: func() {
		sheet := &s.chat.find.pins.sheet
		sheet.from = geom.Rect{}
		sheet.Toggle()
	}}
}

// drawDMHead draws the bar over a conversation and returns where its pin button is.
func (s *Screen) drawDMHead(c *widget.Context, r geom.Rect, m model, conv *dm.Conversation) geom.Rect {
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y + r.H - edge, W: r.W, H: edge}, 0, c.Theme.Border)
	session := s.Session.DM()
	name := s.conversationName(c, m, conv)
	verified := !conv.Group && session.Trust(conv.Peer).Verified

	h := &s.dm.head
	h.wire(s)
	h.c, h.m, h.conv, h.name = c, m, conv, name
	right := r.Right() - dmSidePad
	var at geom.Rect
	put := func(b *widget.IconButton) {
		size := b.Measure(c, 0)
		at = geom.Rect{X: right - size.W, Y: r.Y + (r.H-edge-size.H)/2, W: size.W, H: size.H}
		b.Draw(c, at)
		right = at.X - dmHeadGap
	}
	if c.Viewport.W <= dmNarrow {
		put(&h.close)
	}
	put(&h.menu)
	if conv.Group {
		put(&h.members)
	} else {
		h.safety.Lit = verified
		put(&h.safety)
	}
	h.pins.Lit = s.chat.find.pins.sheet.open
	put(&h.pins)
	pinsAt := at
	h.menuAt = at

	x := r.X + dmSidePad
	avatar := widget.Avatar{Name: name, Size: dmHeadAvatar, Font: dmHeadAvatarFont}
	if conv.Group {
		avatar.Icon = "users-three"
	}
	avatar.Draw(c, geom.Rect{X: x, Y: r.Y + (r.H-edge-dmHeadAvatar)/2, W: dmHeadAvatar, H: dmHeadAvatar})
	x += dmHeadAvatar + dmHeadGap

	extra := float32(dmLockBox + dmHeadGap)
	var count, tag string
	if conv.Group {
		count = c.Strings.Plural("dm.group.count", len(conv.Members), "count", strconv.Itoa(len(conv.Members)))
		extra += c.Paint.TextWidth(count, dmCountStyleTxt) + dmHeadGap
	} else if verified {
		tag = c.T("dm.verified")
		extra += c.Paint.TextWidth(tag, dmVerifiedStyle) + 2*dmVerifiedPadX + dmHeadGap
	}
	width := min(c.Paint.TextWidth(name, dmHeadNameStyle), max(dmHeadNameMin, right-x-extra))
	top := r.Y + (r.H-edge-dmHeadNameLine)/2
	c.Paint.TextIn(geom.Rect{X: x, Y: top, W: width, H: dmHeadNameLine}, name, x, top, dmHeadNameLine, dmHeadNameStyle, c.Theme.Text)
	x += width + dmHeadGap
	c.Paint.Icon("lock-simple", geom.Rect{X: x + (dmLockBox-dmLockSize)/2, Y: r.Y + (r.H-edge-dmLockSize)/2, W: dmLockSize, H: dmLockSize}, c.Theme.Live)
	x += dmLockBox + dmHeadGap
	switch {
	case count != "":
		c.Paint.Text(count, x, r.Y+(r.H-edge-dmCountText*1.5)/2, dmCountText*1.5, dmCountStyleTxt, c.Theme.Muted)
	case tag != "":
		w := c.Paint.TextWidth(tag, dmVerifiedStyle) + 2*dmVerifiedPadX
		h := float32(dmVerifiedSize*1.5 + 2*dmVerifiedPadY)
		pill := geom.Rect{X: x, Y: r.Y + (r.H-edge-h)/2, W: w, H: h}
		c.Paint.Fill(pill, h/2, theme.WithAlpha(c.Theme.Live, 0.18))
		c.Paint.Text(tag, pill.X+dmVerifiedPadX, pill.Y+dmVerifiedPadY, dmVerifiedSize*1.5, dmVerifiedStyle, c.Theme.Live)
	}
	return pinsAt
}

// openDMMenu is the small menu behind the dots: what can be done to the conversation as a whole.
func (s *Screen) openDMMenu(c *widget.Context, m model, conv *dm.Conversation, name string, button geom.Rect) {
	d := &s.dm
	if d.menu.IsOpen() {
		d.menu.Close()
		return
	}
	session := s.Session.DM()
	id := conv.ID
	d.menu.Head = ""
	if conv.Group {
		d.menu.Items = []widget.MenuItem{{Label: c.T("dm.group.members"), OnPick: func() { s.showMembers(c, id) }}}
		if conv.Owner == m.state.Me.ID {
			d.menu.Items = append(d.menu.Items, widget.MenuItem{Label: c.T("dm.group.rename"), OnPick: func() { s.renameGroup(c, id) }})
		}
		d.menu.Items = append(d.menu.Items,
			widget.MenuItem{Label: c.T("dm.menu.clear"), Danger: true, OnPick: func() { s.clearConversation(c, id, name) }},
			widget.MenuItem{Label: c.T("dm.group.leave"), Danger: true, OnPick: func() { s.leaveGroup(c, id, name) }})
	} else {
		peer := conv.Peer
		blocked := session.Blocked(peer)
		block := widget.MenuItem{Label: c.T("dm.menu.block", "name", name)}
		if blocked {
			block.Label = c.T("dm.menu.unblock", "name", name)
		}
		block.OnPick = func() { s.dmDo(func(ctx context.Context) error { return session.SetBlocked(ctx, peer, !blocked) }) }
		d.menu.Items = []widget.MenuItem{
			{Label: c.T("dm.safety.menu"), OnPick: func() { s.showSafety(c, m, peer) }},
			block,
			{Label: c.T("dm.menu.clear"), Danger: true, OnPick: func() { s.clearConversation(c, id, name) }},
		}
	}
	d.menu.OpenBelow(button)
}

// dmDo does something that asks the server, off the interface's thread, and shows the words of what went wrong.
func (s *Screen) dmDo(run func(ctx context.Context) error) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
		defer cancel()
		s.fail(s.dm.feed.words(run(ctx)))
	}()
}

// dmBanner is a line over the conversation: what is wrong with it, and what can be done.
type dmBanner struct {
	text    string
	buttons []*widget.Button
}

func (s *Screen) dmBanners(c *widget.Context, m model, conv *dm.Conversation) []dmBanner {
	session := s.Session.DM()
	var out []dmBanner
	keyChanged := func(user int) {
		name := s.nameOf(m, user, c.T("reactions.someone"))
		out = append(out, dmBanner{text: c.T("dm.banner.key_changed", "name", name), buttons: []*widget.Button{
			{Label: c.T("dm.banner.compare"), Variant: widget.Ghost, Small: true, OnClick: func() { s.showSafety(c, m, user) }},
			{Label: c.T("dm.banner.accept"), Variant: widget.Primary, Small: true, OnClick: func() { session.AcceptKey(user) }},
		}})
	}
	if conv.Group {
		for _, id := range conv.Members {
			if id != m.state.Me.ID && session.Trust(id).KeyChanged {
				keyChanged(id)
			}
		}
		return out
	}
	name := s.nameOf(m, conv.Peer, c.T("reactions.someone"))
	peer := conv.Peer
	switch {
	case session.Blocked(peer):
		out = append(out, dmBanner{text: c.T("dm.banner.blocked", "name", name), buttons: []*widget.Button{
			{Label: c.T("dm.menu.unblock", "name", name), Variant: widget.Ghost, Small: true, OnClick: func() {
				s.dmDo(func(ctx context.Context) error { return session.SetBlocked(ctx, peer, false) })
			}},
		}})
	}
	if !session.CanWriteTo(peer) {
		out = append(out, dmBanner{text: c.T("dm.banner.no_key", "name", name)})
	} else if session.Trust(peer).KeyChanged {
		keyChanged(peer)
	}
	return out
}

func (s *Screen) drawDMBanner(c *widget.Context, r geom.Rect, m model, conv *dm.Conversation) float32 {
	banners := s.dmBanners(c, m, conv)
	if len(banners) == 0 {
		return 0
	}
	edge := c.Hairline()
	y := r.Y + dmBannerGap
	for _, b := range banners {
		inner := r.W - 2*(dmBannerPadX+edge)
		buttonsW := float32(0)
		buttonH := float32(0)
		for i, button := range b.buttons {
			size := button.Measure(c, 0)
			buttonsW += size.W
			if i > 0 {
				buttonsW += dmBannerRowGap
			}
			buttonH = max(buttonH, size.H)
		}
		text := &widget.Text{Content: b.text, Tone: widget.ToneText, Wrap: true, Style: dmBannerStyle, LineHeight: dmBannerLine}
		beside := len(b.buttons) == 0 || inner-buttonsW-dmBannerRowGap >= dmBannerText
		textW := inner
		if beside && len(b.buttons) > 0 {
			textW = inner - buttonsW - dmBannerRowGap
		}
		textH := text.Measure(c, textW).H
		content := textH
		if len(b.buttons) > 0 {
			content = max(textH, buttonH)
			if !beside {
				content = textH + dmBannerRowGap + buttonH
			}
		}
		box := geom.Rect{X: r.X, Y: y, W: r.W, H: content + 2*(dmBannerPadY+edge)}
		c.Paint.Fill(box, dmBannerRadius, theme.WithAlpha(c.Theme.Tint, dmBannerFill))
		c.Paint.Stroke(box, dmBannerRadius, edge, theme.WithAlpha(c.Theme.Tint, dmBannerBorder))
		x, top := box.X+edge+dmBannerPadX, box.Y+edge+dmBannerPadY
		textY := top
		if beside {
			textY += (content - textH) / 2
		}
		text.Draw(c, geom.Rect{X: x, Y: textY, W: textW, H: textH})
		bx, by := box.Right()-edge-dmBannerPadX-buttonsW, top+(content-buttonH)/2
		if !beside {
			bx, by = x, top+textH+dmBannerRowGap
		}
		for _, button := range b.buttons {
			size := button.Measure(c, 0)
			button.Draw(c, geom.Rect{X: bx, Y: by, W: size.W, H: size.H})
			bx += size.W + dmBannerRowGap
		}
		y += box.H + dmBannerGap
	}
	return y - r.Y
}
