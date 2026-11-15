package channels

import (
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/dm"
	"harmony/v2/internal/emoji"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/markdown"
	"harmony/v2/internal/screens/poll"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	msgPadX       = 6.4
	msgPadY       = 2.4
	msgPadGrouped = 0.96
	rowRadiusMsg  = 6
	rowHoverAlpha = 0.04
	msgAvatar     = 29.6
	msgAvatarFont = 11.2
	msgAvatarTop  = 1.7
	msgGapX       = 9.6
	msgHead       = 18.2
	msgNameSize   = 14
	msgWhenSize   = 12
	msgWhenLine   = 15.6
	msgWhenDrop   = 1.8
	msgWhenGap    = 7.2
	msgWhenAlpha  = 0.5
	gutterWidth   = 36
	gutterSize    = 9.6
	replyHeight   = 18.9
	replySize     = 11.48
	replyLine     = 16.07
	replyAvatar   = 9.3
	replyIndent   = 34.86
	replyGap      = 4.02
	replyTop      = 1.15
	replyElbowX   = 12.63
	replyElbowW   = 16.2
	replyElbowA   = 0.3
	toolW         = 29.4
	toolH         = 26.2
	toolGap       = 1.6
	toolPad       = 2.4
	toolRadius    = 8
	toolIcon      = 15.2
	toolRise      = 8
	toolInset     = 8
	dayMs         = 24 * 60 * 60 * 1000
	groupWindow   = 5 * 60 * 1000
)

var (
	nameStyle   = paint.TextStyle{Size: msgNameSize, Weight: paint.Semibold}
	whenStyle   = paint.TextStyle{Size: msgWhenSize, Weight: paint.Regular}
	gutterTime  = paint.TextStyle{Size: gutterSize, Weight: paint.Regular}
	replyName   = paint.TextStyle{Size: replySize, Weight: paint.Semibold}
	editedStyle = paint.TextStyle{Size: 11.2, Weight: paint.Regular}
	replyText   = paint.TextStyle{Size: replySize, Weight: paint.Regular}
)

// row is one message as laid out in the log this frame.
type row struct {
	entry   *chat.Entry
	grouped bool
	top     float32
	height  float32
	lead    float32
	tail    float32
}

// entryLayout is what is kept of a message between frames: its text laid out for one width.
type entryLayout struct {
	width     float32
	zoom      float32
	text      *widget.RichText
	embed     *embedLayout
	embedKey  string
	embedGone bool
	link      string
	linkKnown bool
	when      string
	short     string
	size      string
	emojis    *chat.EmojiSet
	owner     *chat.Entry
	reactions reactionStrip
	poll      *poll.Card
	dm        *dm.Message
}

func isGrouped(prev, cur *hclient.ChatMessage) bool {
	return prev != nil && prev.UserID == cur.UserID && cur.Reply == nil && prev.Title == "" && cur.Title == "" && cur.CreatedAt-prev.CreatedAt < groupWindow
}

func (s *Screen) layoutOf(c *widget.Context, m model, e *chat.Entry, width float32) *entryLayout {
	l, _ := e.Layout.(*entryLayout)
	if l == nil {
		l = &entryLayout{}
		e.Layout = l
	}
	set := s.Session.Chat().Emojis()
	rebuilt := l.text == nil || l.width != width || l.zoom != c.Paint.Zoom || l.emojis != set
	if rebuilt || l.owner != e {
		l.owner, l.emojis = e, set
		l.reactions = layoutReactions(c, e.Msg.Reactions, set, width)
	}
	if rebuilt {
		l.width, l.zoom = width, c.Paint.Zoom
		l.when, l.short = messageTime(c, e.Msg.CreatedAt, false), messageTime(c, e.Msg.CreatedAt, true)
		l.size = formatBytes(e.Msg.AttachmentBytes)
		blocks := markdown.Parse(e.Msg.Body)
		find := emojiFinder(set)
		if markdown.EmojiOnly(e.Msg.Body, func(name string) bool { _, ok := find(name); return ok }) {
			markdown.Enlarge(blocks)
		}
		l.text = widget.NewRichTextChips(c, blocks, width, s.chips(m), find)
		if e.Msg.Body == "" || e.Msg.Poll != nil {
			l.text.Height = 0
		}
	}
	return l
}

// emojiFinder resolves a :name: to one of the server's emoji or a standard one; the server's win, as in the Electron client.
func emojiFinder(set *chat.EmojiSet) widget.EmojiFunc {
	return func(name string) (widget.InlineEmoji, bool) {
		if e := set.Find(name); e != nil {
			return widget.InlineEmoji{Key: e.Hash, Fetch: e.Fetch}, true
		}
		if char, ok := emoji.Lookup(name); ok {
			return widget.InlineEmoji{Char: char}, true
		}
		return widget.InlineEmoji{}, false
	}
}

// mentioned resolves an @name against the people on the server.
func (s *Screen) mentioned(m model) widget.Mentioned {
	return func(name string) (bool, bool) {
		me := strings.ToLower(m.state.Me.Nickname)
		if name == "everyone" {
			return true, true
		}
		for _, a := range m.state.Members {
			if strings.ToLower(a.Nickname) == name {
				return true, name == me
			}
		}
		return false, false
	}
}

func (s *Screen) nameOf(m model, id int, fallback string) string {
	for _, a := range m.state.Members {
		if a.ID == id {
			return a.Name()
		}
	}
	return fallback
}

// bodyWidth is the width the words and attachments of a message get.
func bodyWidth(logWidth float32) float32 {
	return logWidth - logGutter - 2*msgPadX - msgAvatar - msgGapX
}

func (s *Screen) rowHeight(c *widget.Context, m model, r *row, width float32) float32 {
	msg := &r.entry.Msg
	pad := float32(msgPadY)
	if r.grouped {
		pad = msgPadGrouped
	}
	h := 2 * pad
	r.lead, r.tail = s.postBlocks(c, msg, width)
	h += r.lead + r.tail
	if msg.Reply != nil {
		h += replyHeight
	}
	if !r.grouped {
		h += msgHead
	}
	body := s.layoutOf(c, m, r.entry, width)
	h += body.text.Height
	h += s.attachmentHeight(c, r.entry, width)
	h += s.pollHeight(c, m, r.entry, body, width)
	h += s.embedHeight(c, body, msg, width, false)
	h += body.reactions.height
	return h
}

func (s *Screen) drawRow(c *widget.Context, m model, r *row, x, y, w float32, hovered bool) {
	msg := &r.entry.Msg
	if r.lead > 0 {
		s.drawPostLead(c, msg, x, y, w)
		y += r.lead
	}
	bounds := geom.Rect{X: x, Y: y, W: w - logGutter, H: r.height - r.lead - r.tail}
	s.drawHighlight(c, bounds, msg, m.state.Me)
	if hovered {
		c.Paint.Fill(bounds, rowRadiusMsg, theme.WithAlpha(c.Theme.Tint, rowHoverAlpha))
	}
	s.drawRowMarks(c, bounds, msg)
	if s.chat.editing != nil && s.chat.editing.ID == msg.ID {
		c.Paint.Fill(bounds, rowRadiusMsg, theme.WithAlpha(c.Theme.Accent, 0.1))
		c.Paint.Fill(geom.Rect{X: bounds.X, Y: bounds.Y, W: 3, H: bounds.H}, 0, c.Theme.Accent)
	}
	pad := float32(msgPadY)
	if r.grouped {
		pad = msgPadGrouped
	}
	top := y + pad
	if msg.Reply != nil {
		s.drawReply(c, m, msg.Reply, x+msgPadX, top, bounds.W-2*msgPadX)
		top += replyHeight
	}
	bx := x + msgPadX + msgAvatar + msgGapX
	bodyW := bodyWidth(w)
	body := s.layoutOf(c, m, r.entry, bodyW)
	if r.grouped {
		if hovered {
			label := body.short
			tw := c.Paint.TextWidth(label, gutterTime)
			c.Paint.Text(label, x+msgPadX+gutterWidth-4-tw, top, 21, gutterTime, theme.WithAlpha(c.Theme.Text, msgWhenAlpha))
		}
	} else {
		who := s.nameOf(m, msg.UserID, msg.Nickname)
		face := geom.Rect{X: x + msgPadX, Y: top + msgAvatarTop, W: msgAvatar, H: msgAvatar}
		widget.Avatar{ID: msg.UserID, Name: who, Size: msgAvatar, Font: msgAvatarFont}.Draw(c, face)
		look := c.NameStyle(msg.UserID, who)
		nameW := c.DrawName(who, look, bx, top, msgHead, nameStyle, c.Theme.Text)
		s.pressProfile(c, msg.UserID, face, geom.Rect{X: bx, Y: top, W: nameW, H: msgHead})
		at := bx + nameW + msgWhenGap
		at += s.drawOPBadge(c, msg, at-msgWhenGap, top)
		c.Paint.Text(body.when, at, top+msgWhenDrop, msgWhenLine, whenStyle, theme.WithAlpha(c.Theme.Text, msgWhenAlpha))
		top += msgHead
	}
	if body.text.Height > 0 {
		s.drawBody(c, body.text, msg.ID, bx, top)
		if msg.EditedAt > 0 {
			ex, ey := body.text.End()
			c.Paint.Text(c.T("dm.edited"), bx+ex, top+ey, 21, editedStyle, theme.WithAlpha(c.Theme.Muted, 0.9))
		}
		top += body.text.Height
	}
	top += s.drawAttachment(c, r.entry, body, bx, top, bodyW)
	top += s.drawPoll(c, m, r.entry, body, bx, top, bodyW)
	s.drawEmbed(c, body, msg, bx, top, bodyW)
	if body.reactions.height > 0 {
		top += s.embedHeight(c, body, msg, bodyW, false)
		s.drawReactions(c, m, r, body, bx, top, bodyW)
	}
	if r.tail > 0 {
		s.drawPostTail(c, x, y+r.height-r.lead-r.tail, w, len(s.chat.rows) == 1)
	}
}

func (s *Screen) drawReply(c *widget.Context, m model, reply *hclient.Reply, x, y, w float32) {
	ex, ey := x+replyElbowX, y+replyHeight/2
	elbow := theme.WithAlpha(c.Theme.Tint, replyElbowA)
	c.Paint.Line(ex+6, ey, ex+replyElbowW, ey, 2, elbow)
	c.Paint.Line(ex, ey+6, ex, y+replyHeight+replyLineDrop, 2, elbow)
	c.Paint.Line(ex, ey+6, ex+1.2, ey+2.2, 2, elbow)
	c.Paint.Line(ex+1.2, ey+2.2, ex+6, ey, 2, elbow)

	at := x + replyIndent
	if area := (geom.Rect{X: at, Y: y, W: x + w - at, H: replyHeight}); !reply.Deleted && c.Hovered(area) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(area) {
			c.Claim()
			s.goTo(s.chat.channel, reply.ID)
		}
	}
	if reply.Deleted {
		c.Paint.Text(c.T("app.the_original_message_was_deleted"), at, y+replyTop, replyLine, replyText, theme.WithAlpha(c.Theme.Muted, 0.75))
		return
	}
	who := s.nameOf(m, reply.UserID, reply.Nickname)
	widget.Avatar{ID: reply.UserID, Name: who, Size: replyAvatar, Font: 6.888}.Draw(c, geom.Rect{X: at, Y: y + (replyHeight-replyAvatar)/2, W: replyAvatar, H: replyAvatar})
	at += replyAvatar + replyGap
	tag := "@" + who
	c.Paint.Text(tag, at, y+replyTop, replyLine, replyName, theme.WithAlpha(c.Theme.Accent, 0.9))
	at += c.Paint.TextWidth(tag, replyName) + replyGap
	text := strings.ReplaceAll(reply.Body, "\n", " ")
	if text == "" {
		text = reply.AttachmentName
	}
	c.Paint.TextIn(geom.Rect{X: at, Y: y, W: max(0, x+w-at), H: replyHeight}, text, at, y+replyTop, replyLine, replyText, c.Theme.Muted)
}

const replyLineDrop = 2.3

// messageTime is a message's time of day, with the date added once it is a day old.
func messageTime(c *widget.Context, ms int64, short bool) string {
	t := time.UnixMilli(ms)
	layout := "03:04 PM"
	if c.Strings.Code() != "en" {
		layout = "15:04"
	}
	if short || time.Since(t).Milliseconds() < dayMs {
		return t.Format(layout)
	}
	date := "02 Jan"
	if t.Year() != time.Now().Year() {
		date = "02 Jan 2006"
	}
	return t.Format(date + ", " + layout)
}

type toolKind int

const (
	toolReply toolKind = iota
	toolReact
	toolStar
	toolPin
	toolSave
	toolEdit
	toolDelete
)

type tool struct {
	kind   toolKind
	icon   string
	danger bool
	lit    rl.Color
}

// act does what a pressed tool is for; react is where the reaction tool sits, which the picker opens from.
func (s *Screen) act(kind toolKind, m model, msg *hclient.ChatMessage, react geom.Rect) {
	switch kind {
	case toolReply:
		s.beginReply(msg)
	case toolReact:
		s.openPicker(react, func(v string) { s.chat.picker.Close(); s.toggleReaction(msg, v, true) })
	case toolStar:
		s.toggleStar(m, msg)
	case toolPin:
		if msg.Title != "" {
			s.pinPost(msg.ID, msg.PostPinnedAt == 0)
			return
		}
		s.pin(msg.ID, !msg.Pinned)
	case toolSave:
		s.save(msg.AttachmentHash, msg.AttachmentName)
	case toolEdit:
		s.beginEdit(msg)
	case toolDelete:
		if msg.Title != "" {
			s.deletePost(s.chat.find.c, msg.ID)
			return
		}
		s.deleteMessage(msg.ID)
	}
}

// drawTools is the badge over a message's corner: reply, and for your own messages edit and delete.
func (s *Screen) drawTools(c *widget.Context, m model, r *row, x, y, w float32) geom.Rect {
	msg := &r.entry.Msg
	var react geom.Rect
	private := dmOf(r.entry)
	readable := private == nil || private.Kind == dm.KindText && !private.Unreadable
	var buf [7]tool
	tools := buf[:0]
	if readable {
		tools = append(tools, tool{kind: toolReply, icon: "arrow-bend-up-left"}, tool{kind: toolReact, icon: "smiley"})
		if private == nil {
			tools = append(tools, tool{kind: toolStar, icon: "star", lit: lit(s.isStarred(m, msg.ID), starInk)})
		}
		if s.canPin(msg) {
			tools = append(tools, tool{kind: toolPin, icon: "push-pin", lit: lit(msg.Pinned || msg.PostPinnedAt != 0, c.Theme.Accent)})
		}
		if private != nil && msg.AttachmentHash != "" {
			tools = append(tools, tool{kind: toolSave, icon: "download-simple"})
		}
	}
	mine := msg.UserID == m.state.Me.ID
	if mine || s.mayDeletePost(msg) || s.mayDeleteMessage(m, msg) {
		if mine && readable && msg.Poll == nil {
			tools = append(tools, tool{kind: toolEdit, icon: "pencil-simple"})
		}
		if private == nil || private.Kind == dm.KindText {
			tools = append(tools, tool{kind: toolDelete, icon: "trash", danger: true})
		}
	}
	if len(tools) == 0 {
		return geom.Rect{}
	}
	n := float32(len(tools))
	edge := c.Hairline()
	box := geom.Rect{W: n*toolW + (n-1)*toolGap + 2*(toolPad+edge), H: toolH + 2*(toolPad+edge)}
	box.X, box.Y = x+w-logGutter-toolInset-box.W, y-toolRise
	c.Paint.Shadow(box, toolRadius, 2, 10, rl.NewColor(0, 0, 0, 100))
	c.Paint.Fill(box, toolRadius, c.Theme.Surface)
	c.Paint.Stroke(box, toolRadius, edge, c.Theme.Border)
	for i, t := range tools {
		cell := geom.Rect{X: box.X + toolPad + edge + float32(i)*(toolW+toolGap), Y: box.Y + toolPad + edge, W: toolW, H: toolH}
		if t.kind == toolReact {
			react = cell
		}
		ink := c.Theme.Text
		if t.danger {
			ink = c.Theme.DangerSoft
		}
		if t.lit.A > 0 {
			ink = t.lit
		}
		if c.Hovered(cell) {
			c.SetCursor(rl.MouseCursorPointingHand)
			fill := theme.WithAlpha(c.Theme.Tint, 0.12)
			if t.danger {
				fill = theme.WithAlpha(c.Theme.Danger, 0.2)
			}
			c.Paint.Fill(cell, 5, fill)
			if c.Clicked(cell) {
				c.Claim()
				s.act(t.kind, m, msg, react)
			}
		}
		c.Paint.Icon(t.icon, geom.Rect{X: cell.X + (toolW-toolIcon)/2, Y: cell.Y + (toolH-toolIcon)/2, W: toolIcon, H: toolIcon}, ink)
	}
	return box
}
