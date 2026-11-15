package channels

import (
	"context"
	"slices"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/dm"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/voicenote"
)

const (
	dmPadX          = 16
	dmTitleSize     = 16.8
	dmTitleLine     = 25.2
	dmNoteTop       = 11.2
	dmNoteTextSize  = 13.12
	dmNoteTextLine  = 18.37
	dmActionTop     = 12.8
	dmActionGap     = 6.4
	dmFindTop       = 9.6
	dmListTop       = 6.4
	dmListPadTop    = 4
	dmListPadX      = 8
	dmListPadBottom = 12
	dmRowPadY       = 8.8
	dmRowPadX       = 9.6
	dmRowGap        = 12
	dmRowAvatar     = 40
	dmRowAvatarFont = 13.6
	dmRowNameSize   = 15.2
	dmRowNameLine   = 22.8
	dmRowTimeSize   = 11.52
	dmRowTimeLine   = 17.28
	dmRowTimeDrop   = 4.4
	dmRowTextSize   = 13.12
	dmRowTextLine   = 19.68
	dmRowRadius     = 8
	dmRowCurrent    = 0.07
	dmCountSize     = 10.88
	dmCountHeight   = 17.6
	dmCountPadX     = 4.8
	dmFindHeadTop   = 9.6
	dmFindHeadSize  = 11.52
	dmFindHeadLine  = 17.28
	dmFindHeadBot   = 3.2
	dmNoneSize      = 14
	dmNonePadY      = 12.8
	dmDisabledAlpha = 0.6
	dmEmptySize     = 13.6
	dmEmptyLine     = 19.04
)

var (
	dmTitleStyle = paint.TextStyle{Size: dmTitleSize, Weight: paint.Semibold}
	dmNameStyle  = paint.TextStyle{Size: dmRowNameSize, Weight: paint.Semibold}
	dmTimeStyle  = paint.TextStyle{Size: dmRowTimeSize, Weight: paint.Regular}
	dmTextStyle  = paint.TextStyle{Size: dmRowTextSize, Weight: paint.Regular}
	dmCountStyle = paint.TextStyle{Size: dmCountSize, Weight: paint.Bold}
	dmHeadStyle  = paint.TextStyle{Size: dmFindHeadSize, Weight: paint.Regular, Spacing: dmFindHeadSize * 0.04}
	dmNoteStyle  = paint.TextStyle{Size: dmNoteTextSize, Weight: paint.Regular}
	dmEmptyStyle = paint.TextStyle{Size: dmEmptySize, Weight: paint.Regular}
)

// dmList is the column of conversations beside the one that is open.
type dmList struct {
	scroll   widget.Scroll
	find     widget.TextField
	items    []widget.Component
	key      dmItemsKey
	newGroup widget.Button
	action   widget.Button
	wired    bool

	column  widget.Column
	padded  widget.Padded
	note    widget.Text
	empty   widget.Text
	noteBtn widget.Button
	noteDo  func(c *widget.Context)
}

// dmRowText is what a row of the list says, kept until the conversation changes.
type dmRowText struct {
	last  *dm.Message
	at    int64
	day   int
	title string
	when  string
	line  string
}

func (s *Screen) conversationName(c *widget.Context, m model, conv *dm.Conversation) string {
	if conv.Group {
		if conv.Title != "" {
			return conv.Title
		}
		return c.T("dm.group.untitled")
	}
	return s.nameOf(m, conv.Peer, c.T("reactions.someone"))
}

func (s *Screen) rowText(c *widget.Context, m model, conv *dm.Conversation) *dmRowText {
	d := &s.dm
	t := d.rows[conv.ID]
	if t == nil {
		t = &dmRowText{}
		d.rows[conv.ID] = t
	}
	title := s.conversationName(c, m, conv)
	day := time.Now().YearDay()
	if t.last != conv.Last || t.at != conv.LastAt || t.day != day || t.title != title {
		t.last, t.at, t.day, t.title = conv.Last, conv.LastAt, day, title
		t.when = ""
		if conv.LastAt != 0 {
			t.when = dmWhen(c, conv.LastAt)
		}
		t.line = d.feed.previewLine(conv)
	}
	return t
}

// dmWhen is a time of day for today and a date for any other day.
func dmWhen(c *widget.Context, ms int64) string {
	t := time.UnixMilli(ms)
	now := time.Now()
	if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
		return messageTime(c, ms, true)
	}
	return t.Format("02 Jan")
}

func (f *dmFeed) previewLine(conv *dm.Conversation) string {
	last := conv.Last
	if last == nil {
		return ""
	}
	switch {
	case last.Unreadable:
		return f.t("dm.unreadable_short")
	case last.Kind == dm.KindCall:
		return f.callLine(last)
	case last.Kind == dm.KindGroup:
		return f.groupLine(last)
	}
	said := dm.Preview(last)
	if said == "" {
		return ""
	}
	if last.File != nil && voicenote.IsVoiceNote(last.File.Name, last.File.Media) {
		said = f.t("voice.preview")
	}
	switch {
	case last.User == f.me:
		return f.t("dm.you_prefix", "text", said)
	case conv.Group:
		return f.t("dm.group.sender_prefix", "name", f.name(last.User), "text", said)
	}
	return said
}

func (s *Screen) drawDMList(c *widget.Context, r geom.Rect, m model) {
	d := &s.dm
	l := &d.list
	edge := c.Hairline()
	c.Paint.Fill(r, 0, theme.WithAlpha(c.Theme.Tint, 0.025))
	c.Paint.Fill(geom.Rect{X: r.Right() - edge, Y: r.Y, W: edge, H: r.H}, 0, c.Theme.Border)
	inner := geom.Rect{X: r.X, Y: r.Y, W: r.W - edge, H: r.H}
	session := s.Session.DM()
	status := session.Status()
	ready := status.State == dm.Ready
	if !l.wired {
		l.wired = true
		l.find.Compact = true
		l.newGroup = widget.Button{Icon: "users-three", Variant: widget.Ghost, Small: true, OnClick: func() { s.newGroup(c) }}
		l.noteBtn = widget.Button{Variant: widget.Primary, Small: true, OnClick: func() { l.noteDo(c) }}
	}

	s.drawDMListHead(c, inner, ready)
	y := inner.Y + dmHeadHeight
	y = s.drawDMNote(c, inner, y, status)
	if ready {
		l.find.Placeholder = c.T("dm.find")
		y += dmFindTop
		h := l.find.Measure(c, 0).H
		l.find.Draw(c, geom.Rect{X: inner.X + dmPadX, Y: y, W: inner.W - 2*dmPadX, H: h})
		y += h
	}

	needle := strings.ToLower(strings.TrimSpace(l.find.Value))
	items := s.cachedItems(c, m, session, ready, needle)
	bottom := inner.Bottom()
	if ready && len(items) == 0 && needle == "" {
		text := &l.empty
		*text = widget.Text{Content: c.T("dm.empty"), Tone: widget.ToneMuted, Wrap: true, Style: dmEmptyStyle, LineHeight: dmEmptyLine}
		w := inner.W - 2*dmPadX
		h := text.Measure(c, w).H
		text.Draw(c, geom.Rect{X: inner.X + dmPadX, Y: bottom - h, W: w, H: h})
		bottom -= h + dmNoteTop
	}
	top := y + dmListTop
	l.scroll.Bar = true
	l.column.Children = items
	l.padded = widget.Padded{Top: dmListPadTop, Left: dmListPadX, Right: dmListPadX, Bottom: dmListPadBottom, Child: &l.column}
	l.scroll.Child = &l.padded
	l.scroll.Draw(c, geom.Rect{X: inner.X, Y: top, W: inner.W, H: max(0, bottom-top)})
}

func (s *Screen) drawDMListHead(c *widget.Context, r geom.Rect, ready bool) {
	l := &s.dm.list
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y + dmHeadHeight - edge, W: r.W, H: edge}, 0, c.Theme.Border)
	c.Paint.Text(c.T("dm.title"), r.X+dmPadX, r.Y+(dmHeadHeight-dmTitleLine)/2, dmTitleLine, dmTitleStyle, c.Theme.Text)
	if !ready {
		return
	}
	size := l.newGroup.Measure(c, 0)
	l.newGroup.Draw(c, geom.Rect{X: r.Right() - dmPadX - size.W, Y: r.Y + (dmHeadHeight-size.H)/2, W: size.W, H: size.H})
}

// drawDMNote says what stands between the person and their conversations, with the way through it, and returns where the list goes on.
func (s *Screen) drawDMNote(c *widget.Context, r geom.Rect, y float32, status dm.Status) float32 {
	l := &s.dm.list
	var text, action string
	var do func(c *widget.Context)
	switch status.State {
	case dm.Loading:
		text = c.T("dm.loading")
	case dm.Unsupported:
		text = c.T("dm.unsupported")
	case dm.Failed:
		text = c.T("dm.failed", "message", status.Failure)
		if status.Failure == "keychain" {
			text = c.T("dm.keychain")
		}
		action, do = c.T("dm.retry"), func(*widget.Context) { s.dmRetry() }
	case dm.Locked:
		text, action, do = c.T("dm.locked_note"), c.T("dm.unlock"), s.showUnlock
	default:
		if status.NeedsBackup {
			text, action, do = c.T("dm.backup_note"), c.T("dm.show_recovery"), s.showBackupKey
		}
	}
	if text == "" {
		return y
	}
	w := r.W - 2*dmPadX
	note := &l.note
	*note = widget.Text{Content: text, Tone: widget.ToneMuted, Wrap: true, Style: dmNoteStyle, LineHeight: dmNoteTextLine}
	h := note.Measure(c, w).H
	y += dmNoteTop
	note.Draw(c, geom.Rect{X: r.X + dmPadX, Y: y, W: w, H: h})
	y += h
	if action != "" {
		button := &l.noteBtn
		button.Label, l.noteDo = action, do
		bh := button.Measure(c, 0).H
		y += dmActionTop
		button.Draw(c, geom.Rect{X: r.X + dmPadX, Y: y, W: w, H: bh})
		y += bh
	}
	return y
}

// dmItemsKey is what the rows of the list were made from: they are made again when any of it changes.
type dmItemsKey struct {
	first   **dm.Conversation
	count   int
	needle  string
	current int
	members int
	people  int
	zoom    float32
	lang    string
	today   int
}

func (s *Screen) cachedItems(c *widget.Context, m model, session *dm.Session, ready bool, needle string) []widget.Component {
	l := &s.dm.list
	convs := session.Conversations()
	key := dmItemsKey{count: len(convs), needle: needle, current: s.dm.current, members: len(m.state.Members), zoom: c.Paint.Zoom, lang: c.Strings.Code(), today: time.Now().YearDay()}
	if len(convs) > 0 {
		key.first = &convs[0]
	}
	if ready {
		key.people = 1
	}
	if key != l.key || l.items == nil && ready {
		l.key = key
		l.items = s.dmItems(c, m, ready, needle)
	}
	return l.items
}

func (s *Screen) dmRetry() {
	session := s.Session.DM()
	go session.Start(context.Background())
}

// dmItems is the rows of the list: the conversations, narrowed to what is being looked for, and then the people nobody has written to yet.
func (s *Screen) dmItems(c *widget.Context, m model, ready bool, needle string) []widget.Component {
	if !ready {
		return nil
	}
	var items []widget.Component
	session := s.Session.DM()
	have := map[int]bool{}
	for _, conv := range session.Conversations() {
		if !conv.Group {
			have[conv.Peer] = true
		}
		if !s.dmMatches(c, m, conv, needle) {
			continue
		}
		items = append(items, dmConvRow{s: s, conv: conv, text: s.rowText(c, m, conv), current: conv.ID == s.dm.current})
	}
	if needle == "" {
		return items
	}
	var people []dmPerson
	for _, a := range m.state.Members {
		if a.ID == m.state.Me.ID || have[a.ID] || !strings.Contains(strings.ToLower(a.Name()), needle) {
			continue
		}
		people = append(people, dmPerson{id: a.ID, name: a.Name()})
	}
	slices.SortFunc(people, func(a, b dmPerson) int { return strings.Compare(strings.ToLower(a.name), strings.ToLower(b.name)) })
	if len(people) > 0 {
		items = append(items, dmFindHead{text: c.T("dm.find_people")})
		for _, p := range people {
			items = append(items, dmPersonRow{s: s, id: p.id, name: p.name, keyed: session.CanWriteTo(p.id)})
		}
	}
	if len(items) == 0 {
		items = append(items, dmFindNone{text: c.T("dm.find_none")})
	}
	return items
}

type dmPerson struct {
	id   int
	name string
}

func (s *Screen) dmMatches(c *widget.Context, m model, conv *dm.Conversation, needle string) bool {
	if needle == "" {
		return true
	}
	if strings.Contains(strings.ToLower(s.conversationName(c, m, conv)), needle) {
		return true
	}
	if !conv.Group {
		return false
	}
	for _, id := range conv.Members {
		if strings.Contains(strings.ToLower(s.nameOf(m, id, "")), needle) {
			return true
		}
	}
	return false
}

func dmRowHeight() float32 { return 2*dmRowPadY + dmRowNameLine + dmRowTextLine }

type dmConvRow struct {
	s       *Screen
	conv    *dm.Conversation
	text    *dmRowText
	current bool
}

func (dmConvRow) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: dmRowHeight()}
}

func (r dmConvRow) Draw(c *widget.Context, b geom.Rect) {
	hovered := c.Hovered(b)
	if hovered || r.current {
		c.Paint.Fill(b, dmRowRadius, theme.WithAlpha(c.Theme.Tint, dmRowCurrent))
	}
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(b) {
			c.Claim()
			r.s.openConversation(r.conv.ID)
		}
	}
	avatar := widget.Avatar{Name: r.text.title, Size: dmRowAvatar, Font: dmRowAvatarFont}
	if r.conv.Group {
		avatar.Icon = "users-three"
	}
	avatar.Draw(c, geom.Rect{X: b.X + dmRowPadX, Y: b.Y + (b.H-dmRowAvatar)/2, W: dmRowAvatar, H: dmRowAvatar})
	x := b.X + dmRowPadX + dmRowAvatar + dmRowGap
	right := b.Right() - dmRowPadX
	top := b.Y + dmRowPadY

	timeW := c.Paint.TextWidth(r.text.when, dmTimeStyle)
	c.Paint.Text(r.text.when, right-timeW, top+dmRowTimeDrop, dmRowTimeLine, dmTimeStyle, c.Theme.Muted)
	nameClip := geom.Rect{X: x, Y: top, W: max(0, right-timeW-8-x), H: dmRowNameLine}
	c.Paint.TextIn(nameClip, r.text.title, x, top, dmRowNameLine, dmNameStyle, c.Theme.Text)

	line := top + dmRowNameLine
	end := right
	if r.conv.Unread > 0 {
		label := widget.BadgeCount(r.conv.Unread)
		w := max(dmCountHeight, c.Paint.TextWidth(label, dmCountStyle)+2*dmCountPadX)
		pill := geom.Rect{X: right - w, Y: line + (dmRowTextLine-dmCountHeight)/2, W: w, H: dmCountHeight}
		c.Paint.Fill(pill, dmCountHeight/2, c.Theme.Accent)
		c.Paint.Text(label, pill.X+(w-c.Paint.TextWidth(label, dmCountStyle))/2, pill.Y, dmCountHeight, dmCountStyle, rl.White)
		end = pill.X - 8
	}
	ink := c.Theme.Muted
	if r.conv.Unread > 0 {
		ink = c.Theme.Text
	}
	c.Paint.TextIn(geom.Rect{X: x, Y: line, W: max(0, end-x), H: dmRowTextLine}, r.text.line, x, line, dmRowTextLine, dmTextStyle, ink)
}

type dmPersonRow struct {
	s     *Screen
	id    int
	name  string
	keyed bool
}

func (r dmPersonRow) height() float32 {
	if r.keyed {
		return 2*dmRowPadY + dmRowAvatar
	}
	return dmRowHeight()
}

func (r dmPersonRow) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: r.height()}
}

func (r dmPersonRow) Draw(c *widget.Context, b geom.Rect) {
	alpha := float32(1)
	if !r.keyed {
		alpha = dmDisabledAlpha
	} else if c.Hovered(b) {
		c.Paint.Fill(b, dmRowRadius, theme.WithAlpha(c.Theme.Tint, dmRowCurrent))
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(b) {
			c.Claim()
			r.s.dm.list.find.Value = ""
			r.s.openWith(c, r.id)
		}
	}
	widget.Avatar{Name: r.name, Size: dmRowAvatar, Font: dmRowAvatarFont, Dim: !r.keyed}.Draw(c, geom.Rect{X: b.X + dmRowPadX, Y: b.Y + (b.H-dmRowAvatar)/2, W: dmRowAvatar, H: dmRowAvatar})
	x := b.X + dmRowPadX + dmRowAvatar + dmRowGap
	top := b.Y + dmRowPadY
	if r.keyed {
		top = b.Y + (b.H-dmRowNameLine)/2
	}
	clip := geom.Rect{X: x, Y: top, W: max(0, b.Right()-dmRowPadX-x), H: dmRowNameLine}
	c.Paint.TextIn(clip, r.name, x, top, dmRowNameLine, dmNameStyle, theme.WithAlpha(c.Theme.Text, alpha))
	if !r.keyed {
		c.Paint.TextIn(geom.Rect{X: x, Y: top + dmRowNameLine, W: clip.W, H: dmRowTextLine}, c.T("dm.group.no_key"), x, top+dmRowNameLine, dmRowTextLine, dmTextStyle, theme.WithAlpha(c.Theme.Muted, alpha))
	}
}

type dmFindHead struct{ text string }

func (dmFindHead) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: dmFindHeadTop + dmFindHeadLine + dmFindHeadBot}
}

func (h dmFindHead) Draw(c *widget.Context, b geom.Rect) {
	c.Paint.Text(strings.ToUpper(h.text), b.X+dmRowPadX, b.Y+dmFindHeadTop, dmFindHeadLine, dmHeadStyle, c.Theme.Muted)
}

type dmFindNone struct{ text string }

func (dmFindNone) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: 2*dmNonePadY + dmNoneSize*1.5}
}

func (n dmFindNone) Draw(c *widget.Context, b geom.Rect) {
	c.Paint.Text(n.text, b.X+dmRowPadX, b.Y+dmNonePadY, dmNoneSize*1.5, paint.TextStyle{Size: dmNoneSize, Weight: paint.Regular}, c.Theme.Muted)
}

func (s *Screen) showBackupKey(c *widget.Context) { s.showRecoveryKey(c, true) }
