package channels

import (
	"context"
	"os"
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
	chatHeadH      = 43.8
	chatHeadBox    = 33.3
	chatHeadGap    = 9.6
	chatLogGap     = 8
	logPad         = 8
	msgGap         = 5.6
	logGutter      = 10
	scrollStep     = 48
	thumbWidth     = 6
	thumbInset     = 2
	thumbMin       = 24
	toBottomSize   = 35.2
	toBottomRight  = 17.6
	toBottomBottom = 11.2
	toBottomShown  = 120
	olderTrigger   = 400
	typingSize     = 12.48
	typingLine     = 16.224
	typingPadX     = 6.4
	typingPadBot   = 2.4
	formTop        = 8
	composerRadius = 10
	composerPadY   = 4
	composerPadX   = 5.6
	composerBtn    = 38
	composerGap    = 2.4
	composerIcon   = 20.8
	plusIcon       = 23.2
	replyBarSize   = 13.12
	replyBarLine   = 19.68
	replyBarBtn    = 28
	replyBarPadTop = 3.2
	replyBarPadBot = 4.8
	replyBarMargin = 2.4
	pendingW       = 120
	pendingPic     = 88
	pendingMeta    = 38
	pendingGap     = 8
	uploadPad      = 4.8
	uploadHead     = 28
	uploadBar      = 6
	headLine       = 22.8
)

var (
	headStyle     = paint.TextStyle{Size: 15.2, Weight: paint.Semibold, Spacing: 15.2 * 0.06}
	typingStyle   = paint.TextStyle{Size: typingSize, Weight: paint.Regular}
	replyBarStyle = paint.TextStyle{Size: replyBarSize, Weight: paint.Regular}
	replyBarBold  = paint.TextStyle{Size: replyBarSize, Weight: paint.Semibold}
	pendingName   = paint.TextStyle{Size: 12.48, Weight: paint.Regular}
	pendingSize   = paint.TextStyle{Size: 11.52, Weight: paint.Regular}
)

type chatState struct {
	channel   int
	dm        bool
	wiredDM   bool
	offset    float32
	lastID    int
	news      newsMark
	rows      []row
	toolsFor  int
	headName  string
	head      string
	tools     geom.Rect
	unfolded  map[int]bool
	find      finder
	input     widget.TextArea
	files     []string
	sending   *chat.Sending
	reply     *hclient.ChatMessage
	editing   *hclient.ChatMessage
	picking   bool
	wired     int
	picker    widget.EmojiPicker
	tip       reactionTip
	emojis    *chat.EmojiSet
	pick      logPick
	shown     []shownText
	mention   mentionList
	menu      widget.ContextMenu
	notified  notifiedList
	pasted    pastedFiles
	editDraft string

	layers      bool
	emojiAnchor geom.Rect
	openEmoji   func()
	insertEmoji func(string)
}

func (s *Screen) openText(id int) {
	s.leaveForum()
	if s.chat.channel == id && !s.chat.dm {
		return
	}
	s.cancelRecording()
	s.chat.dm = false
	s.chat.channel, s.chat.offset, s.chat.lastID = id, 0, 0
	s.chat.reply, s.chat.editing, s.chat.files, s.chat.editDraft = nil, nil, nil, ""
	s.chat.input.Clear()
	s.chat.input.RequestFocus()
	s.openNews(id)
}

func (s *Screen) closeText() {
	s.leaveForum()
	s.cancelRecording()
	s.chat.channel, s.chat.dm = 0, false
	s.Session.Chat().SetOpen(0)
}

func (s *Screen) channelNamed(m model, id int) string {
	if id < 0 {
		return s.forum.title
	}
	for _, ch := range m.channels {
		if ch.ID == id {
			return ch.Name
		}
	}
	return ""
}

func (s *Screen) drawChat(c *widget.Context, r geom.Rect, m model) {
	st := &s.chat
	if st.unfolded == nil {
		st.unfolded = map[int]bool{}
	}
	if st.wired != st.channel || st.wiredDM != st.dm {
		st.wired, st.wiredDM = st.channel, st.dm
		st.input.Placeholder = c.T("app.message")
		if st.dm {
			st.input.Placeholder = c.T("dm.placeholder")
		}
		st.input.OnSubmit = s.submit
		st.input.OnPaste = s.pasteClipboard
		st.input.MaxLength = composerMaxLength
		st.input.OnChange = s.typed
	}
	if st.channel < 0 {
		st.input.Placeholder = s.forum.placeholder
	}
	store := s.chatFeed()
	name := s.channelNamed(m, st.channel)
	if !st.dm {
		s.drawChatHead(c, m, r, name)
	}
	s.takeDrops(c)

	look := s.look()
	composer := s.composerHeight(c, r.W-2*look.formSide)
	formH := look.formTop + typingLine + composer + look.formBottom
	above := look.head
	if !st.dm {
		above += pinStripSpace(store.Pinned(st.channel))
	}
	log := geom.Rect{X: r.X, Y: r.Y + above, W: r.W, H: max(0, r.H-above-formH)}
	entries, more, loading := store.Messages(st.channel)
	s.drawLog(c, m, log, entries, more, loading)

	form := geom.Rect{X: r.X + look.formSide, Y: r.Bottom() - formH, W: r.W - 2*look.formSide, H: formH}
	s.drawTyping(c, m, geom.Rect{X: form.X, Y: form.Y + look.formTop, W: form.W, H: typingLine})
	box := geom.Rect{X: form.X, Y: form.Bottom() - look.formBottom - composer, W: form.W, H: composer}
	s.drawComposer(c, m, box, name)
	if st.dm && s.dm.locked {
		s.dimComposer(c, box)
	}
	s.showReactionLayers(c, m)
}

func (s *Screen) drawChatHead(c *widget.Context, m model, r geom.Rect, name string) {
	if s.chat.channel < 0 {
		s.drawThreadHead(c, m, r, name)
		return
	}
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y + chatHeadH - edge, W: r.W, H: edge}, 0, c.Theme.Border)
	if s.chat.headName != name || s.chat.head == "" {
		s.chat.headName, s.chat.head = name, "#"+name
	}
	title := widget.Heading{Title: s.chat.head}
	tw := c.Paint.TextWidth(widget.Upper(s.chat.head), headStyle)
	title.Draw(c, geom.Rect{X: r.X, Y: r.Y + (chatHeadBox-headLine)/2, W: tw, H: headLine})

	s.drawFinderHead(c, m, r, tw)
}

func (s *Screen) drawTyping(c *widget.Context, m model, r geom.Rect) {
	var names []string
	for _, id := range s.chatFeed().Typing(s.chat.channel) {
		if id != m.state.Me.ID {
			names = append(names, s.nameOf(m, id, "?"))
		}
	}
	if len(names) == 0 {
		return
	}
	var text string
	switch len(names) {
	case 1:
		text = c.T("typing.one", "a", names[0])
	case 2:
		text = c.T("typing.two", "a", names[0], "b", names[1])
	case 3:
		text = c.T("typing.three", "a", names[0], "b", names[1], "c", names[2])
	default:
		text = c.T("typing.many")
	}
	clip := geom.Rect{X: r.X + typingPadX, Y: r.Y, W: r.W - 2*typingPadX, H: r.H}
	c.Paint.TextIn(clip, text, clip.X, r.Y, r.H, typingStyle, c.Theme.Muted)
}

func (s *Screen) drawLog(c *widget.Context, m model, log geom.Rect, entries []*chat.Entry, more, loading bool) {
	st := &s.chat
	rows := st.rows[:0]
	var prev *hclient.ChatMessage
	look := s.look()
	inset, padTop := look.logInset, look.logPadTop
	area := geom.Rect{X: log.X + inset, Y: log.Y, W: log.W - 2*inset, H: log.H}
	bw := bodyWidth(area.W)
	y := padTop
	divAt := st.news.dividerAt(entries)
	for i, e := range entries {
		rw := row{entry: e, grouped: isGrouped(prev, &e.Msg) && i != divAt}
		rw.height = s.rowHeight(c, m, &rw, bw)
		if i > 0 {
			y += msgGap
		}
		if i == divAt {
			st.news.top = y + dividerAbove
			y += dividerAbove + dividerBelow + msgGap
		}
		rw.top = y
		y += rw.height
		rows = append(rows, rw)
		prev = &e.Msg
	}
	st.rows = rows
	total := y + logPad
	maxOffset := max(0, total-log.H)

	if n := len(entries); n > 0 {
		last := entries[n-1].Msg.ID
		if st.lastID != 0 && last > st.lastID && st.offset > 0 {
			for i := n - 1; i >= 0 && entries[i].Msg.ID > st.lastID; i-- {
				st.offset += rows[i].height + msgGap
			}
		}
		st.lastID = last
	}
	hover := c.Hovered(log)
	if hover {
		st.offset += c.In.Wheel * scrollStep
	}
	s.landJump(c, log, rows, total)
	st.offset = min(max(st.offset, 0), maxOffset)
	viewTop := max(0, total-log.H-st.offset)

	if viewTop < olderTrigger && more && !loading {
		s.chatFeed().LoadOlder(st.channel)
	}
	s.jumpToNews(total, log.H, entries, more, loading)
	if !st.news.jumping && len(entries) > 0 {
		s.chatFeed().MarkRead(st.channel, entries[len(entries)-1].Msg.ID)
	}

	c.Paint.PushClip(log)
	hovered := -1
	for i := range rows {
		rw := &rows[i]
		if rw.top+rw.height < viewTop {
			continue
		}
		if rw.top > viewTop+log.H {
			break
		}
		cell := geom.Rect{X: area.X, Y: log.Y + rw.top - viewTop, W: area.W - logGutter, H: rw.height}
		over := hover && (c.Hovered(cell) || (rw.entry.Msg.ID == st.toolsFor && c.Hovered(st.tools)))
		if over {
			hovered = i
		}
		s.drawRow(c, m, rw, area.X, cell.Y, area.W, over)
	}
	if divAt >= 0 {
		s.drawDivider(c, area, log.Y+st.news.top-viewTop)
	}
	st.toolsFor = 0
	if hovered >= 0 {
		rw := &rows[hovered]
		st.tools = s.drawTools(c, m, rw, area.X, log.Y+rw.top+rw.lead-viewTop, area.W)
		st.toolsFor = rw.entry.Msg.ID
	}
	c.Paint.PopClip()
	s.logSelect(c, log, rows, viewTop)

	if total > log.H {
		s.drawThumb(c, log, total, viewTop)
	}
	if st.offset > toBottomShown {
		s.drawToBottom(c, log)
	}
}

func (s *Screen) drawThumb(c *widget.Context, log geom.Rect, total, viewTop float32) {
	h := max(thumbMin, log.H*log.H/total)
	y := log.Y + viewTop/(total-log.H)*(log.H-h)
	c.Paint.Fill(geom.Rect{X: log.Right() - thumbWidth - thumbInset, Y: y, W: thumbWidth, H: h}, thumbWidth/2, theme.WithAlpha(c.Theme.Tint, 0.2))
}

func (s *Screen) drawToBottom(c *widget.Context, log geom.Rect) {
	box := geom.Rect{X: log.Right() - toBottomRight - toBottomSize, Y: log.Bottom() - toBottomBottom - toBottomSize, W: toBottomSize, H: toBottomSize}
	hovered := c.Hovered(box)
	fill, ink := c.Theme.Surface2, c.Theme.Text
	if hovered {
		fill, ink = c.Theme.Accent, rl.White
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(box) {
			c.Claim()
			s.chat.offset = 0
		}
	}
	cx, cy := box.X+box.W/2, box.Y+box.H/2
	c.Paint.Circle(cx, cy, box.W/2, c.Theme.BorderStrong)
	c.Paint.Circle(cx, cy, box.W/2-c.Hairline(), fill)
	c.Paint.Icon("arrow-down", geom.Rect{X: cx - 8, Y: cy - 8, W: 16, H: 16}, ink)
}

func (s *Screen) beginReply(msg *hclient.ChatMessage) {
	copied := *msg
	s.chat.reply, s.chat.editing = &copied, nil
	s.chat.input.RequestFocus()
}

func (s *Screen) beginEdit(msg *hclient.ChatMessage) {
	copied := *msg
	if s.chat.editing == nil {
		s.chat.editDraft = s.chat.input.Value()
	}
	s.chat.editing, s.chat.reply = &copied, nil
	s.chat.input.SetValue(msg.Body)
	s.chat.input.RequestFocus()
}

func (s *Screen) deleteMessage(id int) {
	if s.chat.dm {
		s.confirmDelete(id)
		return
	}
	s.askDelete(id)
}

func (s *Screen) typed() {
	if strings.TrimSpace(s.chat.input.Value()) == "" {
		s.chatFeed().Stopped(s.chat.channel)
		return
	}
	if s.chat.editing == nil {
		s.chatFeed().Typed(s.chat.channel)
	}
}

// submit sends what is in the box: an edit, or a message with the files waiting beside it.
func (s *Screen) submit() {
	st := &s.chat
	body := strings.TrimSpace(st.input.Value())
	if st.sending != nil && !st.sending.Done.Load() {
		return
	}
	channel, store := st.channel, s.chatFeed()
	if st.editing != nil {
		if body == "" || body == st.editing.Body {
			s.endEdit()
			return
		}
		id := st.editing.ID
		s.endEdit()
		go func() { s.fail(store.Edit(context.Background(), id, body)) }()
		return
	}
	if body == "" && len(st.files) == 0 {
		return
	}
	replyTo := 0
	if st.reply != nil {
		replyTo = st.reply.ID
	}
	files := st.files
	st.input.Clear()
	st.reply, st.files = nil, nil
	if len(files) > 0 {
		st.sending = store.SendFiles(channel, body, files, replyTo)
		return
	}
	go func() {
		s.fail(store.Send(context.Background(), channel, hclient.Post{Body: body, ReplyTo: replyTo}))
		if replyTo == 0 {
			store.Stopped(channel)
		}
	}()
}

// takeDrops attaches the files dropped on the window.
func (s *Screen) takeDrops(c *widget.Context) {
	for _, path := range c.In.Dropped {
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			s.chat.files = append(s.chat.files, path)
		}
	}
	if len(c.In.Dropped) > 0 {
		s.chat.input.RequestFocus()
	}
}
