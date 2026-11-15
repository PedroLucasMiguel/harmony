package channels

import (
	"image/color"
	"strconv"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	rwBackdrop = 140
	rwWidth    = 480
	rwHeight   = 576
	rwMargin   = 24
	rwHeadPadX = 17.6
	rwHeadPadY = 14.4
	rwTabsW    = 99.2
	rwTabsPad  = 8
	rwTabPadX  = 8
	rwTabPadY  = 6.4
	rwTabGap   = 8
	rwTabGlyph = 20
	rwTabLine  = 28
	rwPeoplePX = 12.8
	rwPeoplePY = 6.4
	rwPersonPY = 6.4
	rwAvatar   = 32
	rwAvatarGp = 11.2
	rwRadius   = 10
	rwCloseBtn = 28
)

var (
	rwTitle = paint.TextStyle{Size: 16, Weight: paint.Semibold}
	rwName  = paint.TextStyle{Size: 14, Weight: paint.Semibold}
	rwSmall = paint.TextStyle{Size: 11.2, Weight: paint.Regular}
	rwTab   = paint.TextStyle{Size: 14, Weight: paint.Regular}
	rwTabB  = paint.TextStyle{Size: 14, Weight: paint.Bold}
	rwGlyph = paint.TextStyle{Size: rwTabGlyph, Weight: paint.Regular}
)

// reactionWindow lists everybody who reacted to a message, an emoji at a time.
type reactionWindow struct {
	screen    *Screen
	m         model
	entry     *chat.Entry
	picked    string
	tabs      widget.Scroll
	people    widget.Scroll
	tabList   tabList
	personRow personList
}

type tabList struct{ w *reactionWindow }
type personList struct{ w *reactionWindow }

func (s *Screen) openAllReactions(c *widget.Context, m model, e *chat.Entry, first string) {
	w := &reactionWindow{screen: s, m: m, entry: e, picked: first}
	w.tabList, w.personRow = tabList{w}, personList{w}
	w.tabs.Child, w.people.Child = &w.tabList, &w.personRow
	c.OpenModal(w)
}

func (w *reactionWindow) reactions() []hclient.Reaction { return w.entry.Msg.Reactions }

func (w *reactionWindow) shown() *hclient.Reaction {
	list := w.reactions()
	for i := range list {
		if list[i].Emoji == w.picked {
			return &list[i]
		}
	}
	if len(list) > 0 {
		return &list[0]
	}
	return nil
}

func (w *reactionWindow) Draw(c *widget.Context, bounds geom.Rect) {
	c.Paint.Fill(bounds, 0, color.RGBA{A: rwBackdrop})
	edge := c.Hairline()
	box := geom.Rect{W: min(rwWidth, bounds.W-2*rwMargin), H: min(rwHeight, bounds.H-2*rwMargin)}
	box.X, box.Y = bounds.X+(bounds.W-box.W)/2, bounds.Y+(bounds.H-box.H)/2
	c.Layer(w)
	if c.EscapeFor(w) || (c.Clicked(bounds) && !c.Hovered(box)) {
		c.Claim()
		c.CloseModal()
		return
	}
	c.Claim()
	c.Paint.Fill(box, rwRadius, c.Theme.Surface2)
	c.Paint.Stroke(box, rwRadius, edge, theme.WithAlpha(c.Theme.Tint, 0.14))

	headH := float32(2*rwHeadPadY + rwCloseBtn)
	c.Paint.Text(c.T("reactions.title"), box.X+rwHeadPadX, box.Y+(headH-24)/2, 24, rwTitle, c.Theme.Text)
	close := geom.Rect{X: box.Right() - rwHeadPadX - rwCloseBtn, Y: box.Y + rwHeadPadY, W: rwCloseBtn, H: rwCloseBtn}
	if c.Hovered(close) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(close, 6, theme.WithAlpha(c.Theme.Tint, 0.12))
		if c.Clicked(close) {
			c.CloseModal()
			return
		}
	}
	c.Paint.Icon("x", geom.Rect{X: close.X + 6, Y: close.Y + 6, W: 16, H: 16}, c.Theme.Muted)
	c.Paint.Fill(geom.Rect{X: box.X, Y: box.Y + headH, W: box.W, H: edge}, 0, c.Theme.Border)

	body := geom.Rect{X: box.X, Y: box.Y + headH + edge, W: box.W, H: box.H - headH - edge}
	tabs := geom.Rect{X: body.X, Y: body.Y, W: rwTabsW, H: body.H}
	w.tabs.Draw(c, tabs.Inset(rwTabsPad, rwTabsPad, rwTabsPad, rwTabsPad))
	c.Paint.Fill(geom.Rect{X: tabs.Right() - edge, Y: tabs.Y, W: edge, H: tabs.H}, 0, c.Theme.Border)
	w.people.Draw(c, geom.Rect{X: tabs.Right() + rwPeoplePX, Y: body.Y + rwPeoplePY, W: body.W - tabs.W - 2*rwPeoplePX, H: body.H - 2*rwPeoplePY})
}

func (t *tabList) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: float32(len(t.w.reactions())) * rwTabLine}
}

func (t *tabList) Draw(c *widget.Context, r geom.Rect) {
	shown := t.w.shown()
	for i := range t.w.reactions() {
		reaction := &t.w.reactions()[i]
		tab := geom.Rect{X: r.X, Y: r.Y + float32(i)*(rwTabLine+0), W: r.W, H: rwTabLine}
		selected := reaction == shown
		ink, style := c.Theme.Muted, rwTab
		switch {
		case selected:
			c.Paint.Fill(tab, 6, theme.WithAlpha(c.Theme.Accent, 0.18))
			ink, style = c.Theme.Text, rwTabB
		case c.Hovered(tab):
			c.Paint.Fill(tab, 6, theme.WithAlpha(c.Theme.Tint, 0.08))
		}
		if c.Hovered(tab) {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.Clicked(tab) {
				c.Claim()
				t.w.picked = reaction.Emoji
			}
		}
		x := tab.X + rwTabPadX
		if e := customOf(t.w.screen.Session.Chat().Emojis(), reaction.Emoji); e != nil {
			t.w.screen.drawCustom(c, e, geom.Rect{X: x, Y: tab.Y + (tab.H-rwTabGlyph)/2, W: rwTabGlyph, H: rwTabGlyph})
			x += rwTabGlyph
		} else {
			c.Paint.Text(reaction.Emoji, x, tab.Y+(tab.H-rwTabGlyph*1.5)/2, rwTabGlyph*1.5, rwGlyph, ink)
			x += c.Paint.TextWidth(reaction.Emoji, rwGlyph)
		}
		c.Paint.Text(strconv.Itoa(len(reaction.UserIDs)), x+rwTabGap, tab.Y+(tab.H-21)/2, 21, style, ink)
	}
}

func (p *personList) Measure(c *widget.Context, maxWidth float32) geom.Size {
	n := 0
	if r := p.w.shown(); r != nil {
		n = len(r.UserIDs)
	}
	return geom.Size{W: maxWidth, H: float32(n) * (rwAvatar + 2*rwPersonPY)}
}

func (p *personList) Draw(c *widget.Context, r geom.Rect) {
	reaction := p.w.shown()
	if reaction == nil {
		return
	}
	row := float32(rwAvatar + 2*rwPersonPY)
	for i, id := range reaction.UserIDs {
		y := r.Y + float32(i)*row
		if y+row < 0 || y > c.Viewport.H {
			continue
		}
		who := p.w.screen.nameOf(p.w.m, id, c.T("reactions.someone"))
		widget.Avatar{Name: who, Size: rwAvatar, Font: 12.5}.Draw(c, geom.Rect{X: r.X + 3.2, Y: y + rwPersonPY, W: rwAvatar, H: rwAvatar})
		c.Paint.TextIn(geom.Rect{X: r.X, Y: y, W: r.W, H: row}, who, r.X+3.2+rwAvatar+rwAvatarGp, y+(row-21)/2, 21, rwName, c.Theme.Text)
	}
}
