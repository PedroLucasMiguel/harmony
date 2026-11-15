package channels

import (
	"context"
	"image/color"
	"strconv"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/emoji"
	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/markdown"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	reactSize      = 12.8
	reactLine      = 17.92
	reactPadX      = 6.4
	reactPadY      = 1.6
	reactGap       = 4
	reactMarginTop = 3.2
	reactMarginBot = 1.6
	reactPicture   = 14.08
	reactPicMargin = 0.64
	reactMineAlpha = 0.18
	reactCountA    = 0.75
	tipOpenAfter   = 280 * time.Millisecond
	tipCloseAfter  = 160 * time.Millisecond
	tipMargin      = 8
	tipGap         = 6
	tipPadX        = 14.4
	tipPadY        = 11.2
	tipInner       = 12.8
	tipGlyph       = 38.4
	tipRadius      = 10
	tipMaxWidth    = 352
	tipLine        = 21.12
	tipLinkGap     = 4
	tipNamed       = 3
	recentEmoji    = 24
)

var (
	reactStyle = paint.TextStyle{Size: reactSize, Weight: paint.Regular}
	tipStyle   = paint.TextStyle{Size: 14.08, Weight: paint.Regular}
	tipGlyphSt = paint.TextStyle{Size: tipGlyph, Weight: paint.Regular}
)

type reactionChip struct {
	reaction int
	x, y, w  float32
	custom   *chat.Emoji
	count    string
	countX   float32
}

// strip is the row of reactions under a message, laid out for one width.
type reactionStrip struct {
	chips  []reactionChip
	height float32
	rows   float32
}

func reactionHeight(c *widget.Context) float32 { return reactLine + 2*reactPadY + 2*c.Hairline() }

func layoutReactions(c *widget.Context, reactions []hclient.Reaction, set *chat.EmojiSet, width float32) reactionStrip {
	var out reactionStrip
	if len(reactions) == 0 {
		return out
	}
	edge, h := c.Hairline(), reactionHeight(c)
	x, y := float32(0), float32(0)
	for i, r := range reactions {
		ch := reactionChip{reaction: i, count: strconv.Itoa(r.Count)}
		glyph := float32(0)
		if e := customOf(set, r.Emoji); e != nil {
			ch.custom, glyph = e, reactPicture+2*reactPicMargin
		} else {
			glyph = c.Paint.TextWidth(r.Emoji, reactStyle)
		}
		countW := c.Paint.TextWidth(ch.count, reactStyle)
		ch.w = 2*edge + 2*reactPadX + glyph + reactGap + countW
		ch.countX = edge + reactPadX + glyph + reactGap
		if x > 0 && x+ch.w > width {
			x, y = 0, y+h+reactGap
		}
		ch.x, ch.y = x, y
		out.chips = append(out.chips, ch)
		x += ch.w + reactGap
	}
	out.rows = y + h
	out.height = reactMarginTop + out.rows + reactMarginBot
	return out
}

// customOf is the server's emoji a reaction stands for (":name:"), or nil.
func customOf(set *chat.EmojiSet, value string) *chat.Emoji {
	if len(value) < 4 || value[0] != ':' || value[len(value)-1] != ':' {
		return nil
	}
	return set.Find(strings.ToLower(value[1 : len(value)-1]))
}

// reactionTip is the card that opens when the pointer rests on a reaction.
type reactionTip struct {
	entry   *chat.Entry
	emoji   string
	since   time.Time
	seen    time.Time
	shown   bool
	chip    geom.Rect
	card    geom.Rect
	text    *widget.RichText
	textFor *chat.Entry
	paint   func()
	screen  *Screen
	c       *widget.Context
	m       model
}

func (s *Screen) drawReactions(c *widget.Context, m model, r *row, l *entryLayout, x, y, w float32) {
	msg := &r.entry.Msg
	top := y + reactMarginTop
	for i := range l.reactions.chips {
		ch := &l.reactions.chips[i]
		reaction := &msg.Reactions[ch.reaction]
		rect := geom.Rect{X: x + ch.x, Y: top + ch.y, W: ch.w, H: reactionHeight(c)}
		s.drawChip(c, m, r.entry, reaction, ch, rect)
	}
}

func (s *Screen) drawChip(c *widget.Context, m model, e *chat.Entry, reaction *hclient.Reaction, ch *reactionChip, r geom.Rect) {
	edge := c.Hairline()
	hovered := c.Hovered(r)
	border := c.Theme.Border
	if hovered {
		border = c.Theme.BorderStrong
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if reaction.Mine(m.state.Me.ID) {
		border = c.Theme.Accent
		c.Paint.Fill(r, r.H/2, theme.WithAlpha(c.Theme.Accent, reactMineAlpha))
	} else {
		c.Paint.Fill(r, r.H/2, c.Theme.Surface2)
	}
	c.Paint.Stroke(r, r.H/2, edge, border)

	gx, gy := r.X+edge+reactPadX, r.Y+edge+reactPadY
	if ch.custom != nil {
		s.drawCustom(c, ch.custom, geom.Rect{X: gx + reactPicMargin, Y: r.Y + (r.H-reactPicture)/2, W: reactPicture, H: reactPicture})
	} else {
		c.Paint.Text(reaction.Emoji, gx, gy, reactLine, reactStyle, c.Theme.Text)
	}
	c.Paint.Text(ch.count, r.X+ch.countX, gy, reactLine, reactStyle, theme.WithAlpha(c.Theme.Text, reactCountA))

	tip := &s.chat.tip
	if hovered {
		if tip.entry != e || tip.emoji != reaction.Emoji {
			*tip = reactionTip{entry: e, emoji: reaction.Emoji, since: time.Now()}
		}
		tip.seen, tip.chip = time.Now(), r
		if !tip.shown {
			if wait := tipOpenAfter - time.Since(tip.since); wait > 0 {
				redraw.After(wait)
			} else {
				tip.shown = true
			}
		}
		if c.Clicked(r) {
			c.Claim()
			if c.In.Shift {
				s.openAllReactions(c, m, e, reaction.Emoji)
			} else {
				s.toggleReaction(&e.Msg, reaction.Emoji, !reaction.Mine(m.state.Me.ID))
			}
		}
	}
}

func (s *Screen) drawCustom(c *widget.Context, e *chat.Emoji, r geom.Rect) {
	pic := c.Paint.Picture(e.Hash, e.Fetch)
	w, h, ok := pic.Size()
	if !ok {
		return
	}
	if w > h {
		r.Y, r.H = r.Y+r.H*(1-float32(h)/float32(w))/2, r.H*float32(h)/float32(w)
	} else if h > w {
		r.X, r.W = r.X+r.W*(1-float32(w)/float32(h))/2, r.W*float32(w)/float32(h)
	}
	c.Paint.DrawPicture(pic, r, 0, false, theme.Palette{}.Text)
}

func (s *Screen) toggleReaction(msg *hclient.ChatMessage, value string, on bool) {
	id := msg.ID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.chatFeed().React(ctx, id, value, on); err != nil {
			s.fail(err)
		}
	}()
	if on {
		s.rememberEmoji(value)
	}
}

func (s *Screen) rememberEmoji(value string) {
	recent := make([]string, 0, recentEmoji)
	recent = append(recent, value)
	for _, v := range s.Settings.RecentEmoji {
		if v != value && len(recent) < recentEmoji {
			recent = append(recent, v)
		}
	}
	s.Settings.RecentEmoji = recent
	s.Settings.Save()
	s.chat.picker.SetRecent(recent)
}

// showTip draws the who-reacted card while the pointer rests on a reaction (or on the card).
func (s *Screen) showTip(c *widget.Context, m model) {
	tip := &s.chat.tip
	if tip.entry == nil {
		return
	}
	if c.In.Wheel != 0 || c.EscapeBase() || time.Since(tip.seen) > tipCloseAfter && !(tip.shown && tip.card.Contains(c.In.MouseX, c.In.MouseY)) {
		*tip = reactionTip{}
		return
	}
	if !tip.shown {
		return
	}
	redraw.After(tipCloseAfter)
	tip.screen, tip.c, tip.m = s, c, m
	if tip.paint == nil {
		tip.paint = func() { tip.draw(tip.c, tip.screen, tip.m) }
	}
	c.Overlay(tip.paint)
}

func (t *reactionTip) reaction() *hclient.Reaction {
	for i := range t.entry.Msg.Reactions {
		if t.entry.Msg.Reactions[i].Emoji == t.emoji {
			return &t.entry.Msg.Reactions[i]
		}
	}
	return nil
}

func (t *reactionTip) draw(c *widget.Context, s *Screen, m model) {
	reaction := t.reaction()
	if reaction == nil || len(reaction.UserIDs) == 0 {
		return
	}
	edge := c.Hairline()
	custom := customOf(s.Session.Chat().Emojis(), reaction.Emoji)
	glyphW := float32(tipGlyph)
	if custom == nil {
		glyphW = c.Paint.TextWidth(reaction.Emoji, tipGlyphSt)
	}
	room := min(tipMaxWidth, c.Viewport.W-2*tipMargin) - 2*(tipPadX+edge) - glyphW - tipInner
	if t.text == nil || t.textFor != t.entry {
		sentence := t.sentence(c, s, m, reaction)
		width := min(room, c.Paint.TextWidth(sentence, tipStyle)+1)
		t.text = widget.NewRichText(c, []markdown.Block{{Lines: [][]markdown.Span{{{Text: sentence}}}}}, width, nil)
		t.textFor = t.entry
	}
	all := len(reaction.UserIDs) <= tipNamed
	label := c.T("reactions.view_all")
	textH, textW := t.text.Height, t.text.Width
	if all {
		textH += tipLinkGap + tipLine
		textW = max(textW, c.Paint.TextWidth(label, tipStyle))
	}
	box := geom.Rect{W: 2*(tipPadX+edge) + glyphW + tipInner + textW, H: 2*(tipPadY+edge) + max(tipGlyph, textH)}
	box.X = max(tipMargin, min(t.chip.X+t.chip.W/2-box.W/2, c.Viewport.W-box.W-tipMargin))
	box.Y = t.chip.Y - box.H - tipGap
	if box.Y < tipMargin {
		box.Y = t.chip.Bottom() + tipGap
	}
	t.card = box
	c.Popup(box)
	c.Paint.Shadow(box, tipRadius, 8, 28, color.RGBA{A: 128})
	c.Paint.Fill(box, tipRadius, c.Theme.Surface2)
	c.Paint.Stroke(box, tipRadius, edge, c.Theme.Border)
	x, mid := box.X+tipPadX+edge, box.Y+box.H/2
	if custom != nil {
		s.drawCustom(c, custom, geom.Rect{X: x, Y: mid - tipGlyph/2, W: tipGlyph, H: tipGlyph})
	} else {
		c.Paint.Text(reaction.Emoji, x, mid-tipGlyph/2, tipGlyph, tipGlyphSt, c.Theme.Text)
	}
	tx, ty := x+glyphW+tipInner, mid-textH/2
	t.text.Draw(c, tx, ty)
	open := c.Hovered(box) && c.Clicked(box) && !all
	if all {
		link := geom.Rect{X: tx, Y: ty + t.text.Height + tipLinkGap, W: c.Paint.TextWidth(label, tipStyle), H: tipLine}
		ink := c.Theme.Accent
		if c.Hovered(link) {
			c.SetCursor(rl.MouseCursorPointingHand)
			open = c.Clicked(link)
		}
		c.Paint.Text(label, link.X, link.Y, tipLine, tipStyle, ink)
	} else if c.Hovered(box) {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if open {
		c.Claim()
		s.openAllReactions(c, m, t.entry, t.emoji)
		*t = reactionTip{}
	}
}

func (t *reactionTip) sentence(c *widget.Context, s *Screen, m model, r *hclient.Reaction) string {
	names := make([]string, 0, tipNamed+1)
	for _, id := range r.UserIDs[:min(len(r.UserIDs), tipNamed)] {
		names = append(names, s.nameOf(m, id, c.T("reactions.someone")))
	}
	if rest := len(r.UserIDs) - len(names); rest > 0 {
		names = append(names, c.Strings.Plural("reactions.others", rest, "count", strconv.Itoa(rest)))
	}
	return c.T("reactions.reacted_by", "who", strings.Join(names, ", "))
}

// showReactionLayers draws what floats over the chat for reactions: the emoji picker and the who-reacted card.
func (s *Screen) showReactionLayers(c *widget.Context, m model) {
	st := &s.chat
	if !st.layers {
		st.layers = true
		st.picker.Warm()
		st.picker.SetRecent(s.Settings.RecentEmoji)
		st.picker.OnAdd = func() { s.addEmoji(c) }
		st.picker.OnRemove = func(id int) { s.removeEmoji(c, id) }
		st.insertEmoji = func(v string) {
			st.input.Insert(v)
			st.input.RequestFocus()
			s.rememberEmoji(v)
		}
		st.openEmoji = func() { st.picker.Toggle(st.emojiAnchor, st.insertEmoji) }
	}
	if set := s.Session.Chat().Emojis(); set != st.emojis {
		st.emojis = set
		var list []widget.PickerEmoji
		if set != nil {
			list = make([]widget.PickerEmoji, len(set.List))
			for i, e := range set.List {
				list[i] = widget.PickerEmoji{ID: e.ID, Name: e.Name, Key: e.Hash, Fetch: e.Fetch, Removable: e.UploadedBy == m.state.Me.ID}
			}
		}
		st.picker.SetCustom(list)
	}
	st.picker.Show(c)
	s.showTip(c, m)
}

func (s *Screen) openPicker(anchor geom.Rect, pick func(string)) {
	s.chat.picker.Toggle(anchor, pick)
}

func (s *Screen) addEmoji(c *widget.Context) {
	go func() {
		files := filedialog.Pick(c.T("emoji_pop.upload_a_custom_emoji"))
		if len(files) == 0 {
			return
		}
		picture, err := chat.EmojiPicture(files[0])
		if err != nil {
			s.fail(err)
			return
		}
		c.Post(func() { s.nameEmoji(c, files[0], picture) })
	}()
}

func (s *Screen) nameEmoji(c *widget.Context, path string, picture []byte) {
	name := &widget.PromptField{Label: c.T("app.name"), Required: true}
	name.Input.MaxLength = 32
	name.Input.Value = chat.EmojiName(path)
	prompt := &widget.Prompt{
		Title:    c.T("app.name_this_emoji"),
		Text:     c.T("emoji.name_hint"),
		Fields:   []*widget.PromptField{name},
		OK:       c.T("app.add"),
		Cancel:   c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func(values []string) {
			c.CloseModal()
			go func() { s.fail(s.Session.Chat().AddEmoji(context.Background(), emoji.Query(values[0]), picture)) }()
		},
	}
	c.OpenModal(prompt)
}

func (s *Screen) removeEmoji(c *widget.Context, id int) {
	var name string
	for _, e := range s.chat.emojis.List {
		if e.ID == id {
			name = e.Name
		}
	}
	c.OpenModal(&widget.Prompt{
		Title:    c.T("app.remove_2", "name", name),
		Text:     c.T("app.reactions_that_used_it_keep"),
		OK:       c.T("app.remove_3"),
		Cancel:   c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func([]string) {
			c.CloseModal()
			go func() { s.fail(s.Session.Chat().DeleteEmoji(context.Background(), id)) }()
		},
	})
}
