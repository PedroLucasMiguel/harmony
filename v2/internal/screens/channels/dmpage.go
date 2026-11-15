package channels

import (
	"harmony/v2/internal/dm"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	dmListWidth    = 320
	dmHeadHeight   = 52
	dmNarrow       = 720
	dmNoteSize     = 13.6
	dmNoteLine     = 21
	dmNoteBottom   = 8
	dmPickSize     = 16
	dmSidePad      = 16
	dmLogPadTop    = 12
	dmFormTop      = 4
	dmFormBottom   = 16
	dmComposerDimA = 0.55
	dmPinTop       = 6.4
)

// dmState is the page of private messages: the list of conversations, the one that is open, and what is asked of the person on it.
type dmState struct {
	feed    *dmFeed
	page    bool
	back    int
	current int
	locked  bool
	reveal  int

	list   dmList
	head   dmHead
	menu   widget.ContextMenu
	member widget.ContextMenu
	rows   map[int]*dmRowText
	c      *widget.Context
}

// chatLook is how the chat view is laid out: a channel's, or a private conversation's, which sits in a pane of its own.
type chatLook struct {
	head       float32
	logInset   float32
	logPadTop  float32
	formSide   float32
	formTop    float32
	formBottom float32
}

func (s *Screen) look() chatLook {
	if s.chat.dm {
		return chatLook{logInset: dmSidePad, logPadTop: dmLogPadTop, formSide: dmSidePad, formTop: dmFormTop, formBottom: dmFormBottom}
	}
	return chatLook{head: chatHeadH + chatLogGap, logPadTop: logPad, formTop: formTop}
}

// chatFeed is where the open chat gets its messages from.
func (s *Screen) chatFeed() chatFeed {
	if s.chat.dm {
		return s.dm.feed
	}
	return s.Session.Chat()
}

// PrivateAvailable says whether the server has private messages at all.
func (s *Screen) PrivateAvailable() bool {
	d := s.Session.DM()
	return d != nil && d.Status().State != dm.Unsupported
}

// PrivateOpen says whether the page of private messages is showing.
func (s *Screen) PrivateOpen() bool { return s.dm.page }

// PrivateUnread is how many private messages wait.
func (s *Screen) PrivateUnread() int {
	if d := s.Session.DM(); d != nil {
		return d.Status().Unread
	}
	return 0
}

// TogglePrivate opens the page of private messages, or leaves it for where it was opened from.
func (s *Screen) TogglePrivate() {
	d := &s.dm
	if d.page {
		s.leavePrivate()
		return
	}
	if !s.PrivateAvailable() {
		return
	}
	d.back = 0
	if !s.chat.dm {
		d.back = max(0, s.chat.channel)
	}
	s.closeText()
	d.page = true
	redraw.Request()
}

func (s *Screen) leavePrivate() {
	d := &s.dm
	s.closeConversation()
	d.page = false
	d.menu.Close()
	if d.back != 0 {
		s.openText(d.back)
	}
	redraw.Request()
}

// ensureFeed makes the feed the first time it is needed.
func (s *Screen) ensureFeed(c *widget.Context) {
	d := &s.dm
	if d.feed != nil {
		return
	}
	d.c = c
	d.feed = newDMFeed(s.Session.DM(), s.Session.State().Me.ID, redraw.Request)
	d.feed.t = c.T
	d.rows = map[int]*dmRowText{}
}

// dmSetup tells the feed what the frame knows.
func (s *Screen) dmSetup(c *widget.Context, m model) {
	s.ensureFeed(c)
	s.dm.feed.members = m.state.Members
}

func (s *Screen) openConversation(id int) {
	d := &s.dm
	if !d.page && !s.chat.dm {
		d.back = max(0, s.chat.channel)
	}
	s.closeText()
	s.cancelRecording()
	st := &s.chat
	d.current, d.page = id, true
	st.dm, st.channel, st.offset, st.lastID = true, id, 0, 0
	st.reply, st.editing, st.files = nil, nil, nil
	st.input.Clear()
	st.input.RequestFocus()
	s.openNews(id)
	s.chat.find.pins.sheet.Close()
	d.reveal = 0
	redraw.Request()
}

func (s *Screen) closeConversation() {
	d := &s.dm
	if d.current == 0 {
		return
	}
	s.cancelRecording()
	st := &s.chat
	st.dm, st.channel, st.reply, st.editing, st.files = false, 0, nil, nil, nil
	d.current = 0
	s.chat.find.pins.sheet.Close()
	redraw.Request()
}

func (s *Screen) drawDMPage(c *widget.Context, b geom.Rect, m model) {
	d := &s.dm
	s.dmSetup(c, m)
	session := s.Session.DM()
	if d.current != 0 && (session.Status().State != dm.Ready || session.Conversation(d.current) == nil) {
		s.closeConversation()
	}
	listW, _ := s.columnWidth(colDMs, b.W)
	paneX := b.X + listW
	showList, showPane := true, true
	if c.Viewport.W <= dmNarrow {
		listW, paneX = b.W, b.X
		showList, showPane = d.current == 0, d.current != 0
	}
	if showList {
		s.drawDMList(c, geom.Rect{X: b.X, Y: b.Y, W: listW, H: b.H}, m)
		if showPane {
			s.dragHandle(c, colDMs, geom.Rect{X: b.X + listW - handleWidth, Y: b.Y, W: handleWidth + handleInside, H: b.H}, b.X+listW-handleBar, 1, listW, b.W)
		}
	}
	if showPane {
		s.drawDMPane(c, geom.Rect{X: paneX, Y: b.Y, W: b.X + b.W - paneX, H: b.H}, m)
	}
	d.menu.Show(c)
}

func (s *Screen) drawDMPane(c *widget.Context, r geom.Rect, m model) {
	conv := s.Session.DM().Conversation(s.dm.current)
	if conv == nil {
		text := c.T("rail.dm_pick")
		style := paint.TextStyle{Size: dmPickSize, Weight: paint.Regular}
		line := float32(dmPickSize * 1.5)
		c.Paint.Text(text, r.X+(r.W-c.Paint.TextWidth(text, style))/2, r.Y+(r.H-line)/2, line, style, c.Theme.Muted)
		return
	}
	pinsAt := s.drawDMHead(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: dmHeadHeight}, m, conv)
	y := r.Y + dmHeadHeight
	y += s.drawDMBanner(c, geom.Rect{X: r.X + dmSidePad, Y: y, W: r.W - 2*dmSidePad}, m, conv)
	pins := s.dm.feed.Pinned(conv.ID)
	strip := geom.Rect{X: r.X + dmSidePad, Y: y + dmPinTop, W: r.W - 2*dmSidePad, H: pinStripH}
	s.drawPins(c, m, pinsAt, strip, pins)
	if len(pins) > 0 {
		y += dmPinTop + pinStripH
	}
	s.revealPinned(conv.ID)
	note := s.problem()
	noteH := float32(dmNoteBottom)
	if note != "" {
		noteH += dmNoteLine
	}
	s.dm.locked = s.dmLocked(conv)
	s.drawChat(c, geom.Rect{X: r.X, Y: y, W: r.W, H: r.Bottom() - y - noteH}, m)
	if note != "" {
		tone := widget.ToneDanger
		if !s.noteIsError() {
			tone = widget.ToneMuted
		}
		clip := geom.Rect{X: r.X + dmSidePad, Y: r.Bottom() - noteH, W: r.W - 2*dmSidePad, H: dmNoteLine}
		c.Paint.TextIn(clip, note, clip.X, clip.Y, dmNoteLine, paint.TextStyle{Size: dmNoteSize, Weight: paint.Regular}, tone.Color(c.Theme))
	}
}

func (s *Screen) noteIsError() bool { return s.bannerKind() == widget.ErrorBanner }

// dmLocked says whether nothing can be written in a conversation now: its person is blocked or has no key yet.
func (s *Screen) dmLocked(conv *dm.Conversation) bool {
	if conv.Group {
		return false
	}
	d := s.Session.DM()
	return d.Blocked(conv.Peer) || !d.CanWriteTo(conv.Peer)
}

// dimComposer greys the message box out while nothing can be written.
func (s *Screen) dimComposer(c *widget.Context, r geom.Rect) {
	c.Paint.Fill(r, composerRadius, theme.WithAlpha(c.Theme.Bg, dmComposerDimA))
	c.Popup(r)
}

// revealPinned brings a message the person asked to go to into the log, reading older pages until it is there.
func (s *Screen) revealPinned(conv int) {
	d := &s.dm
	if d.reveal == 0 {
		return
	}
	entries, more, loading := d.feed.Messages(conv)
	for _, e := range entries {
		if e.Msg.ID == d.reveal {
			s.chat.find.jump = jumpState{want: d.reveal}
			d.reveal = 0
			return
		}
	}
	switch {
	case more && !loading:
		d.feed.LoadOlder(conv)
	case !more && !loading:
		s.say(s.dm.c.T("app.that_message_is_no_longer"))
		d.reveal = 0
	}
}
