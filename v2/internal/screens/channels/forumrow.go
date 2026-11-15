package channels

import (
	"context"
	"image/color"
	"strconv"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	postPadY       = 12
	postPadX       = 14.4
	postRadius     = 10
	postGap        = 9.6
	postInner      = 4
	postMainGap    = 12.8
	postTitleSize  = 16.8
	postTitleLine  = 25.2
	postSnipSize   = 13.6
	postSnipLine   = 20.4
	postMetaSize   = 12.8
	postMetaLine   = 19.2
	postPinSize    = 17.4
	postPinGap     = 6.4
	postThumbW     = 83.2
	postThumbH     = 57.6
	postThumbR     = 6
	postMetaGapX   = 11.2
	postMetaGapY   = 6.4
	postReplyIcon  = 12.16
	postReplyGap   = 3.84
	postBadgePad   = 6.4
	postPinnedA    = 0.45
	postActiveA    = 0.1
	postMentionA   = 0.07
	postMentionBar = 3
	postToolsInset = 6.4
	postSnipChars  = 160
	postChipGap    = 4.8
	agoRefresh     = time.Minute
)

var (
	postTitleStyle = paint.TextStyle{Size: postTitleSize, Weight: paint.Bold}
	postWhoStyle   = paint.TextStyle{Size: postSnipSize, Weight: paint.Bold}
	postSnipStyle  = paint.TextStyle{Size: postSnipSize, Weight: paint.Regular}
	postMetaStyle  = paint.TextStyle{Size: postMetaSize, Weight: paint.Regular}
	postBadgeStyle = paint.TextStyle{Size: postMetaSize, Weight: paint.Bold}
)

type postStamp struct {
	id       int
	title    string
	body     string
	attach   string
	replies  int
	mentions int
	last     int64
	pinned   int64
	nReact   int
	react    *hclient.Reaction
	width    float32
	zoom     float32
	user     int
}

type postChip struct {
	emoji  string
	count  string
	mine   bool
	w      float32
	countX float32
}

// postLayout is what one post's line is made of, for one width; it is made again only when the post or the width changes.
type postLayout struct {
	stamp   postStamp
	title   []string
	who     string
	whoW    float32
	snippet []string
	indent  float32
	thumb   bool
	chips   []postChip
	chipsW  float32
	badge   string
	badgeW  float32
	count   string
	countW  float32
	ago     string
	agoW    float32
	agoAt   int64
	height  float32
	headH   float32
	main    float32
	slots   [4]metaSlot
	nslots  int
	pic     *paint.Picture
}

// metaSlot is where one thing on a post's last line goes, from the start of the line.
type metaSlot struct {
	kind    byte
	x, y, h float32
}

func stampOf(p *chat.Post, width, zoom float32) postStamp {
	st := postStamp{
		id: p.Msg.ID, title: p.Msg.Title, body: p.Msg.Body, attach: p.Msg.AttachmentHash, replies: p.Replies, mentions: p.Mentions,
		last: p.Last, pinned: p.Msg.PostPinnedAt, nReact: len(p.Msg.Reactions), width: width, zoom: zoom, user: p.Msg.UserID,
	}
	if len(p.Msg.Reactions) > 0 {
		st.react = &p.Msg.Reactions[0]
	}
	return st
}

func snippetOf(msg *hclient.ChatMessage) string {
	text := strings.Join(strings.Fields(msg.Body), " ")
	if text == "" {
		return msg.AttachmentName
	}
	if r := []rune(text); len(r) > postSnipChars {
		return string(r[:postSnipChars-1]) + "…"
	}
	return text
}

func (s *Screen) layoutPost(c *widget.Context, m model, l *postList, p *chat.Post, width float32) *postLayout {
	lay := l.layouts[p.Msg.ID]
	if lay == nil {
		lay = &postLayout{}
		if l.layouts == nil {
			l.layouts = map[int]*postLayout{}
		}
		l.layouts[p.Msg.ID] = lay
	}
	stamp := stampOf(p, width, c.Paint.Zoom)
	now := time.Now().UnixMilli() / int64(agoRefresh/time.Millisecond)
	if lay.stamp == stamp && lay.agoAt == now {
		return lay
	}
	if lay.stamp != stamp {
		s.buildPost(c, m, lay, p, width)
	}
	lay.stamp = stamp
	lay.agoAt = now
	lay.ago = agoText(c, p.Last)
	lay.agoW = c.Paint.TextWidth(lay.ago, postMetaStyle)
	lay.arrange(c.Hairline())
	return lay
}

func (s *Screen) buildPost(c *widget.Context, m model, lay *postLayout, p *chat.Post, width float32) {
	edge := c.Hairline()
	msg := &p.Msg
	lay.thumb = msg.AttachmentHash != "" && msg.MediaType == "image"
	main := width - 2*(edge+postPadX)
	if lay.thumb {
		main -= postThumbW + postMainGap
	}
	titleW := main
	if msg.PostPinnedAt != 0 {
		titleW -= postPinSize + postPinGap
	}
	lay.title = wrapText(c, msg.Title, postTitleStyle, titleW, 0, 0)
	lay.headH = float32(len(lay.title)) * postTitleLine
	if msg.PostPinnedAt != 0 {
		lay.headH = max(lay.headH, postPinSize)
	}
	lay.who = s.nameOf(m, msg.UserID, msg.Nickname) + ":"
	lay.whoW = c.Paint.TextWidth(lay.who, postWhoStyle)
	space := c.Paint.TextWidth(" ", postSnipStyle)
	lay.indent = lay.whoW + space
	lay.snippet = wrapText(c, snippetOf(msg), postSnipStyle, main, lay.indent, 2)

	lay.chips, lay.chipsW = lay.chips[:0], 0
	for i := range msg.Reactions {
		r := &msg.Reactions[i]
		chip := postChip{emoji: r.Emoji, count: strconv.Itoa(r.Count), mine: r.Mine(m.state.Me.ID)}
		glyph := c.Paint.TextWidth(r.Emoji, reactStyle)
		chip.w = 2*edge + 2*reactPadX + glyph + reactGap + c.Paint.TextWidth(chip.count, reactStyle)
		chip.countX = edge + reactPadX + glyph + reactGap
		lay.chips = append(lay.chips, chip)
		lay.chipsW += chip.w
		if i > 0 {
			lay.chipsW += postChipGap
		}
	}
	lay.badge, lay.badgeW = "", 0
	if p.Mentions > 0 {
		lay.badge = "@" + strconv.Itoa(p.Mentions)
		lay.badgeW = c.Paint.TextWidth(lay.badge, postBadgeStyle) + 2*postBadgePad
	}
	lay.count = strconv.Itoa(p.Replies)
	lay.countW = postReplyIcon + postReplyGap + c.Paint.TextWidth(lay.count, postMetaStyle)
	lay.main = main
}

// arrange flows the last line's items (reactions, mentions, answers, the time) into the width, and works out the height of the line.
func (lay *postLayout) arrange(edge float32) {
	type item struct {
		w, h float32
		kind byte
	}
	var items [4]item
	n := 0
	add := func(w, h float32, kind byte) {
		items[n] = item{w, h, kind}
		n++
	}
	if len(lay.chips) > 0 {
		add(lay.chipsW, reactLine+2*reactPadY+2*edge, 'r')
	}
	if lay.badge != "" {
		add(lay.badgeW, postMetaLine, 'm')
	}
	add(lay.countW, postMetaLine, 'c')
	add(lay.agoW, postMetaLine, 'a')

	lay.nslots = 0
	x, y, rowH, first := float32(0), float32(0), float32(0), 0
	place := func(end int) {
		cx := float32(0)
		for _, it := range items[first:end] {
			lay.slots[lay.nslots] = metaSlot{kind: it.kind, x: cx, y: y + (rowH-it.h)/2, h: it.h}
			lay.nslots++
			cx += it.w + postMetaGapX
		}
		first = end
	}
	for i, it := range items[:n] {
		if i > first && x+it.w > lay.main {
			place(i)
			x, y, rowH = 0, y+rowH+postMetaGapY, 0
		}
		x += it.w + postMetaGapX
		rowH = max(rowH, it.h)
	}
	place(n)
	meta := y + rowH
	body := lay.headH + postInner + float32(len(lay.snippet))*postSnipLine + postInner + meta
	if lay.thumb {
		body = max(body, postThumbH)
	}
	lay.height = 2*(edge+postPadY) + body
}

func agoText(c *widget.Context, when int64) string {
	ms := max(0, time.Now().UnixMilli()-when)
	switch {
	case ms < 60_000:
		return c.T("forum.ago_now")
	case ms < 3_600_000:
		return c.T("forum.ago_m", "count", strconv.FormatInt(ms/60_000, 10))
	case ms < 86_400_000:
		return c.T("forum.ago_h", "count", strconv.FormatInt(ms/3_600_000, 10))
	case ms <= 30*86_400_000:
		return c.T("forum.ago_d", "count", strconv.FormatInt(ms/86_400_000, 10))
	}
	return c.T("forum.ago_old")
}

type postTool struct {
	icon   string
	danger bool
	lit    bool
	run    func()
}

// drawPost paints a post's line at r and says whether it was pressed; hovered says the pointer is on it.
func (s *Screen) drawPost(c *widget.Context, m model, l *postList, p *chat.Post, lay *postLayout, r geom.Rect, hovered bool) {
	edge := c.Hairline()
	msg := &p.Msg
	active := msg.ID == s.forum.post
	border := c.Theme.Border
	switch {
	case msg.PostPinnedAt != 0:
		border = theme.WithAlpha(c.Theme.Accent, postPinnedA)
	case active:
		border = c.Theme.Accent
	case hovered:
		border = c.Theme.BorderStrong
	}
	ground := c.Theme.Surface2
	if active || p.Mentions > 0 {
		ground = c.Theme.Bg
	}
	c.Paint.Fill(r, postRadius, ground)
	if active {
		c.Paint.Fill(r, postRadius, theme.WithAlpha(c.Theme.Accent, postActiveA))
	}
	if p.Mentions > 0 {
		c.Paint.Fill(r, postRadius, theme.WithAlpha(c.Theme.Accent, postMentionA))
		c.Paint.PushClip(geom.Rect{X: r.X, Y: r.Y, W: postMentionBar, H: r.H})
		c.Paint.Fill(r, postRadius, c.Theme.Accent)
		c.Paint.PopClip()
	}
	c.Paint.Stroke(r, postRadius, edge, border)

	x := r.X + edge + postPadX
	y := r.Y + edge + postPadY
	main := r.W - 2*(edge+postPadX)
	if lay.thumb {
		main -= postThumbW + postMainGap
		s.drawPostThumb(c, lay, ground, geom.Rect{X: x + main + postMainGap, Y: y, W: postThumbW, H: postThumbH})
	}
	tx := x
	if msg.PostPinnedAt != 0 {
		c.Paint.Icon("push-pin", geom.Rect{X: x, Y: y + (postTitleLine-postPinSize)/2, W: postPinSize, H: postPinSize}, c.Theme.Accent)
		tx += postPinSize + postPinGap
	}
	for i, line := range lay.title {
		c.Paint.Text(line, tx, y+float32(i)*postTitleLine, postTitleLine, postTitleStyle, c.Theme.Text)
	}
	y += lay.headH + postInner
	for i, line := range lay.snippet {
		lx := x
		if i == 0 {
			c.Paint.Text(lay.who, x, y, postSnipLine, postWhoStyle, c.Theme.Text)
			lx += lay.indent
		}
		c.Paint.Text(line, lx, y, postSnipLine, postSnipStyle, c.Theme.Muted)
		y += postSnipLine
	}
	y += postInner
	for _, slot := range lay.slots[:lay.nslots] {
		s.drawMeta(c, lay, slot.kind, geom.Rect{X: x + slot.x, Y: y + slot.y, H: slot.h})
	}
}

func (s *Screen) drawMeta(c *widget.Context, lay *postLayout, kind byte, at geom.Rect) {
	muted := c.Theme.Muted
	switch kind {
	case 'r':
		cx := at.X
		for i := range lay.chips {
			chip := &lay.chips[i]
			box := geom.Rect{X: cx, Y: at.Y, W: chip.w, H: at.H}
			border := c.Theme.Border
			if chip.mine {
				border = c.Theme.Accent
				c.Paint.Fill(box, box.H/2, theme.WithAlpha(c.Theme.Accent, reactMineAlpha))
			} else {
				c.Paint.Fill(box, box.H/2, c.Theme.Surface2)
			}
			c.Paint.Stroke(box, box.H/2, c.Hairline(), border)
			c.Paint.Text(chip.emoji, box.X+c.Hairline()+reactPadX, box.Y+c.Hairline()+reactPadY, reactLine, reactStyle, c.Theme.Text)
			c.Paint.Text(chip.count, box.X+chip.countX, box.Y+c.Hairline()+reactPadY, reactLine, reactStyle, theme.WithAlpha(c.Theme.Text, reactCountA))
			cx += chip.w + postChipGap
		}
	case 'm':
		pill := geom.Rect{X: at.X, Y: at.Y, W: lay.badgeW, H: at.H}
		c.Paint.Fill(pill, pill.H/2, c.Theme.Accent)
		c.Paint.Text(lay.badge, pill.X+postBadgePad, pill.Y, postMetaLine, postBadgeStyle, rl.White)
	case 'c':
		c.Paint.Icon("chat-teardrop", geom.Rect{X: at.X, Y: at.Y + (at.H-postReplyIcon)/2, W: postReplyIcon, H: postReplyIcon}, muted)
		c.Paint.Text(lay.count, at.X+postReplyIcon+postReplyGap, at.Y, postMetaLine, postMetaStyle, muted)
	case 'a':
		c.Paint.Text(lay.ago, at.X, at.Y, postMetaLine, postMetaStyle, muted)
	}
}

func (s *Screen) drawPostThumb(c *widget.Context, lay *postLayout, ground color.RGBA, r geom.Rect) {
	if lay.pic == nil {
		lay.pic = c.Paint.PictureFrom(lay.stamp.attach, s.Session.Chat())
	}
	if _, _, ok := lay.pic.Size(); ok {
		c.Paint.DrawPicture(lay.pic, r, postThumbR, true, ground)
	}
}

// postTools is what a post's line offers to those who may: pin it to the top, delete it.
func (s *Screen) postTools(c *widget.Context, m model, msg *hclient.ChatMessage, buf []postTool) []postTool {
	store := s.Session.Chat()
	if store.CanPinPosts() {
		on := msg.PostPinnedAt != 0
		buf = append(buf, postTool{icon: "push-pin", lit: on, run: func() { s.pinPost(msg.ID, !on) }})
	}
	if msg.UserID == m.state.Me.ID || store.CanDeletePosts() {
		buf = append(buf, postTool{icon: "trash", danger: true, run: func() { s.deletePost(c, msg.ID) }})
	}
	return buf
}

func (s *Screen) pinPost(id int, pinned bool) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		s.fail(s.Session.Chat().PinPost(ctx, id, pinned))
	}()
}

func (s *Screen) deletePost(c *widget.Context, id int) {
	s.confirm(c, c.T("forum.delete_this_post"), "", c.T("app.delete_2"), func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			s.fail(s.Session.Chat().Delete(ctx, id))
		}()
	})
}

// drawPostTools is the badge in a line's corner; it returns whether one of its buttons was pressed.
func (s *Screen) drawPostTools(c *widget.Context, r geom.Rect, tools []postTool) bool {
	if len(tools) == 0 {
		return false
	}
	n := float32(len(tools))
	edge := c.Hairline()
	box := geom.Rect{W: n*toolW + (n-1)*toolGap + 2*(toolPad+edge), H: toolH + 2*(toolPad+edge)}
	box.X, box.Y = r.Right()-postToolsInset-box.W, r.Y+postToolsInset
	c.Paint.Shadow(box, toolRadius, 2, 10, rl.NewColor(0, 0, 0, 100))
	c.Paint.Fill(box, toolRadius, c.Theme.Surface)
	c.Paint.Stroke(box, toolRadius, edge, c.Theme.Border)
	pressed := false
	for i, t := range tools {
		cell := geom.Rect{X: box.X + toolPad + edge + float32(i)*(toolW+toolGap), Y: box.Y + toolPad + edge, W: toolW, H: toolH}
		ink := c.Theme.Text
		switch {
		case t.danger:
			ink = c.Theme.DangerSoft
		case t.lit:
			ink = c.Theme.Accent
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
				pressed = true
				t.run()
			}
		}
		c.Paint.Icon(t.icon, geom.Rect{X: cell.X + (toolW-toolIcon)/2, Y: cell.Y + (toolH-toolIcon)/2, W: toolIcon, H: toolIcon}, ink)
	}
	if c.Hovered(box) {
		pressed = pressed || c.In.Pressed
	}
	return pressed
}
