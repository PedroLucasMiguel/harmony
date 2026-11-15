package channels

import (
	"fmt"
	"image/color"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	rowHeight        = 35.4
	rowGap           = 3
	rowPadX          = 8.8
	rowPadY          = 7.2
	rowGapInner      = 8
	rowRadius        = 6
	kindSize         = 17.6
	kindAlpha        = 0.55
	nameSize         = 14
	timerSize        = 12.48
	viewingAlpha     = 0.18
	hoverAlpha       = 0.06
	memberLine       = 28
	memberPadX       = 5.6
	memberPadY       = 3.2
	memberGap        = 7.2
	memberAvatar     = 20.5
	memberFont       = 8.928
	memberNameSize   = 14.4
	memberBlockTop   = 1.6
	memberBlockLeft  = 8.8
	memberBlockBot   = 5.6
	memberRowSpacing = 0.8
	mutedAlpha       = 0.45
	dockReserve      = 59
	panelMarginBot   = 3.2
)

func (s *Screen) drawChannelList(c *widget.Context, l layout, m model) {
	inner := geom.Rect{X: l.side.X, Y: l.side.Y, W: l.side.W - sidePaddingRight - c.Hairline(), H: l.side.H}
	widget.Heading{Title: c.T("view.channels.channels")}.Draw(c, geom.Rect{X: inner.X, Y: inner.Y, W: inner.W, H: channelHeadH})
	s.drawAddChannel(c, m.state.Actor, geom.Rect{X: inner.X, Y: inner.Y, W: inner.W, H: channelHeadH})

	bottom := l.side.Bottom() - dockReserve
	if m.joined != nil {
		bottom -= panelHeight(c, m) + panelMarginBot
	}
	problem, kind := s.problem(), s.bannerKind()
	if s.Session.Reconnecting() {
		problem, kind = c.T("app.reconnecting"), widget.ErrorBanner
	}
	if problem != "" {
		banner := widget.Banner{Kind: kind, Content: problem}
		h := banner.Measure(c, inner.W).H
		banner.Draw(c, geom.Rect{X: inner.X, Y: bottom - h, W: inner.W, H: h})
		bottom -= h + rowGap
	}
	if s.admin.drag.outOfGroup() {
		bottom -= mvDropoutHeight + 2*mvDropoutMargin
		s.admin.drag.dropout = geom.Rect{X: inner.X, Y: bottom + mvDropoutMargin, W: inner.W, H: mvDropoutHeight}
	}
	list := geom.Rect{X: inner.X, Y: inner.Y + channelHeadH, W: inner.W, H: max(0, bottom-inner.Y-channelHeadH)}
	s.admin.drag.view = list

	s.list.use(s, m)
	s.channelScroll.Child = &s.list
	s.channelScroll.Draw(c, list)
	s.admin.drag.paintDropout(c)
}

// channelList is the channel list as one component: channels, group headings, and under a voice channel who is in it.
// It draws its rows straight from the session's snapshot, so a frame builds nothing.
type channelList struct {
	s      *Screen
	m      model
	state  *app.State
	items  []layoutItem
	timers timerText
}

func (l *channelList) use(s *Screen, m model) {
	l.s, l.m = s, m
	if l.state != m.state {
		l.state, l.items = m.state, buildLayout(l.items[:0], m.channels, m.state.Groups)
	}
}

func (l *channelList) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: l.walk(c, geom.Rect{W: maxWidth}, false)}
}

func (l *channelList) Draw(c *widget.Context, r geom.Rect) {
	l.s.admin.drag.slots = l.s.admin.drag.slots[:0]
	l.walk(c, r, true)
	l.s.updateDrag(c)
}

// walk measures the rows, or with draw also draws them, and returns the height of them all.
func (l *channelList) walk(c *widget.Context, r geom.Rect, draw bool) float32 {
	y, rows := r.Y+rowGap, 0
	for _, item := range l.items {
		if item.group == nil {
			y, rows = l.channel(c, r, y, rows, item.channel, 0, draw)
			continue
		}
		folded := l.s.folded[item.group.ID]
		head := groupRow{screen: l.s, id: item.group.ID, name: item.group.Name, folded: folded, actor: &l.m.state.Actor}
		if folded {
			for _, ch := range item.channels {
				head.mentions += l.s.Session.Chat().Unread(ch.ID).Mentions
			}
		}
		if draw {
			head.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: head.height()})
		}
		y, rows = y+head.height()+rowGap, rows+1
		if folded {
			continue
		}
		for _, ch := range item.channels {
			y, rows = l.channel(c, r, y, rows, ch, groupIndent, draw)
		}
	}
	if rows == 0 {
		return rowGap
	}
	return y - r.Y - rowGap
}

// channel handles a channel's row, and the room's members under it, that start at y; it returns where the next row starts.
func (l *channelList) channel(c *widget.Context, r geom.Rect, y float32, rows int, ch hclient.Channel, indent float32, draw bool) (float32, int) {
	if draw {
		row := l.s.channelRow(ch, l.m, indent, &l.timers)
		row.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: rowHeight})
	}
	y, rows = y+rowHeight+rowGap, rows+1
	if members := l.m.state.Rosters[ch.ID]; ch.Kind == "voice" && len(members) > 0 {
		v := voiceMembers{screen: l.s, members: members, model: l.m, indent: indent, channel: ch.ID}
		h := v.Measure(c, r.W).H
		if draw {
			l.s.admin.drag.grow(h + rowGap)
			v.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		}
		y, rows = y+h+rowGap, rows+1
	}
	return y, rows
}

// timerText is the call's running time as text, made again only when the second changes.
type timerText struct {
	seconds int
	text    string
}

func (t *timerText) of(d time.Duration) string {
	if seconds := int(d.Seconds()); seconds != t.seconds || t.text == "" {
		t.seconds, t.text = seconds, elapsed(d)
	}
	return t.text
}

func (s *Screen) channelRow(ch hclient.Channel, m model, indent float32, timers *timerText) channelRow {
	row := channelRow{screen: s, id: ch.ID, kind: ch.Kind, name: ch.Name, icon: kindIcon(ch.Kind), viewing: s.isViewing(m, ch), indent: indent, actor: &m.state.Actor}
	if ch.GroupID != nil && indent > 0 {
		row.group = *ch.GroupID
	}
	row.lock = s.lockTag(ch, m)
	row.active = ch.Kind == "voice" && m.joined != nil && m.joined.ID == ch.ID && !row.viewing
	if ch.Kind == "voice" {
		row.dim = !row.viewing && !row.active
	} else {
		news := s.Session.Chat().Unread(ch.ID)
		row.unread, row.mentions = news.Unread > 0, news.Mentions
		row.dim = !row.unread && !row.viewing
	}
	if ch.Kind == "voice" && m.joined != nil && m.joined.ID == ch.ID {
		in := time.Since(s.joinedAt)
		row.timer, row.tick = timers.of(in), time.Second-in%time.Second
	}
	return row
}

// pick opens a channel: a text channel shows its log, a voice channel is joined and its room shown.
func (s *Screen) pick(id int, kind string) {
	switch kind {
	case "voice":
		s.closeText()
		if joined := s.seen.joined; joined == nil || joined.ID != id {
			go s.joinVoice(id, "")
		}
	case "text":
		s.openText(id)
	case "forum":
		s.openForum(id)
	}
}

// isViewing is whether a channel is the one the main area shows: the text channel opened, or else the voice room joined.
func (s *Screen) isViewing(m model, ch hclient.Channel) bool {
	if s.forumOpen() {
		return ch.ID == s.forum.channel
	}
	if s.chat.channel != 0 {
		return ch.ID == s.chat.channel
	}
	return m.joined != nil && m.joined.ID == ch.ID
}

func kindIcon(kind string) string {
	switch kind {
	case "voice":
		return "speaker-high"
	case "forum":
		return "chats-teardrop"
	}
	return "hash"
}

func elapsed(d time.Duration) string {
	seconds := int(d.Seconds())
	if seconds >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", seconds/3600, seconds%3600/60, seconds%60)
	}
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}

type channelRow struct {
	name     string
	icon     string
	timer    string
	tick     time.Duration
	viewing  bool
	active   bool
	dim      bool
	unread   bool
	mentions int
	indent   float32
	screen   *Screen
	id       int
	kind     string
	group    int
	actor    *hclient.Actor
	lock     lockState
}

func (r *channelRow) Measure(_ *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: rowHeight}
}

func (r *channelRow) Draw(c *widget.Context, b geom.Rect) {
	b.X, b.W = b.X+r.indent, b.W-r.indent
	r.screen.admin.drag.record(b, 0, false, r.id, r.group, r.name)
	hovered := c.Hovered(b) && (r.kind == "voice" || r.kind == "text" || r.kind == "forum")
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	b = r.drawGround(c, b, hovered)
	ink := c.Theme.Text
	if r.dim && !hovered {
		ink = c.Theme.Muted
	}
	icon := geom.Rect{X: b.X + rowPadX, Y: b.Y + (b.H-kindSize)/2, W: kindSize, H: kindSize}
	c.Paint.Icon(r.icon, icon, theme.WithAlpha(ink, kindAlpha))
	line := float32(nameSize * 1.5)
	nameX := icon.Right() + rowGapInner
	right := b.Right() - rowPadX
	if r.timer != "" {
		redraw.After(r.tick)
		timer := paint.TextStyle{Size: timerSize, Weight: paint.Semibold}
		width := c.Paint.TextWidth(r.timer, timer)
		c.Paint.Text(r.timer, right-width, b.Y+(b.H-timerSize*1.5)/2, timerSize*1.5, timer, c.Theme.Live)
		right -= width + rowGapInner
	}
	if r.lock != notLocked {
		right -= drawLockTag(c, r.lock, right, b) + rowGapInner
	}
	if r.mentions > 0 {
		right -= drawMentionBadge(c, r.mentions, right, b.Y+b.H/2) + rowGapInner
	}
	name := paint.TextStyle{Size: nameSize, Weight: paint.Regular}
	if r.unread || r.mentions > 0 {
		name.Weight = paint.Bold
	}
	if r.active {
		ink = c.Theme.Live
	}
	c.Paint.TextIn(geom.Rect{X: nameX, Y: b.Y, W: right - nameX, H: b.H}, r.name, nameX, b.Y+rowPadY, line, name, ink)
	if hovered && c.Clicked(b) {
		c.Claim()
		r.screen.press(c, r.actor, false, r.id, r.kind, r.group, r.name, r.icon)
	}
	if c.Hovered(b) && c.In.RightPressed {
		r.screen.channelMenu(c, *r.actor, r.id, r.kind, r.name)
	}
}

// voiceMembers lists who is in a voice channel, under its row.
type voiceMembers struct {
	screen  *Screen
	members []hclient.Member
	model   model
	indent  float32
	channel int
}

func (v voiceMembers) Measure(_ *widget.Context, maxWidth float32) geom.Size {
	n := float32(len(v.members))
	return geom.Size{W: maxWidth, H: memberBlockTop + n*memberLine + (n-1)*memberRowSpacing + memberBlockBot}
}

func (v voiceMembers) Draw(c *widget.Context, b geom.Rect) {
	y := b.Y + memberBlockTop
	left := memberBlockLeft + v.indent
	if v.indent > 0 {
		left += groupRuleWidth
		c.Paint.Fill(geom.Rect{X: b.X + v.indent, Y: b.Y, W: groupRuleWidth, H: b.H}, 0, theme.WithAlpha(c.Theme.Tint, groupRuleAlpha))
	}
	for _, member := range v.members {
		row := geom.Rect{X: b.X + left, Y: y, W: b.W - left, H: memberLine}
		v.drawMember(c, row, member)
		y += memberLine + memberRowSpacing
	}
}

func (v voiceMembers) drawMember(c *widget.Context, r geom.Rect, member hclient.Member) {
	if c.Hovered(r) {
		c.Paint.Fill(r, rowRadius, theme.WithAlpha(c.Theme.Tint, hoverAlpha))
	}
	v.screen.personRow(c, r, v.channel, member, v.model)
	alpha := float32(0.9)
	quiet := member.Muted || member.Deafened || member.ForceMuted
	if quiet {
		alpha = mutedAlpha
	}
	avatar := widget.Avatar{Name: member.Nickname, Size: memberAvatar, Font: memberFont, Speaking: v.screen.speaking(v.model, member), Dim: quiet}
	avatar.Draw(c, geom.Rect{X: r.X + memberPadX, Y: r.Y + (r.H-memberAvatar)/2, W: memberAvatar, H: memberAvatar})
	line := float32(memberNameSize * 1.5)
	x := r.X + memberPadX + memberAvatar + memberGap
	c.Paint.TextIn(geom.Rect{X: x, Y: r.Y, W: r.Right() - memberPadX - x, H: r.H}, member.Nickname, x, r.Y+memberPadY, line, paint.TextStyle{Size: memberNameSize, Weight: paint.Regular}, theme.WithAlpha(c.Theme.Text, alpha))
}

// speaking is whether somebody is making sound in the call right now.
func (s *Screen) speaking(m model, member hclient.Member) bool {
	if member.Mid == m.state.MyMid {
		return !m.state.Muted && !m.state.Deafened && s.Session.MicLevel() > speakingLevel
	}
	return s.Session.PeerLevel(member.Mid) > speakingLevel
}

func (s *Screen) fail(err error) {
	s.mu.Lock()
	s.errText, s.isNote = "", false
	if err != nil {
		s.errText = s.errorText(err)
		s.startExpiry()
	}
	s.mu.Unlock()
	redraw.Request()
}

// say shows a short note in the same place as errors.
func (s *Screen) say(text string) {
	s.mu.Lock()
	s.errText, s.isNote = text, true
	if text != "" {
		s.startExpiry()
	}
	s.mu.Unlock()
	redraw.Request()
}

func (s *Screen) bannerKind() widget.BannerKind {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isNote {
		return widget.HintBanner
	}
	return widget.ErrorBanner
}

func (s *Screen) problem() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errText
}

// drawGround paints the row's highlight, and for a row in a group the rule down its left edge; it returns where the contents start.
func (r *channelRow) drawGround(c *widget.Context, b geom.Rect, hovered bool) geom.Rect {
	var fill color.RGBA
	switch {
	case r.viewing:
		fill = theme.WithAlpha(c.Theme.Accent, viewingAlpha)
	case hovered:
		fill = theme.WithAlpha(c.Theme.Tint, hoverAlpha)
	}
	if r.indent == 0 {
		if fill.A != 0 {
			c.Paint.Fill(b, rowRadius, fill)
		}
		return b
	}
	if fill.A != 0 {
		c.Paint.PushClip(b)
		c.Paint.Fill(geom.Rect{X: b.X - rowRadius, Y: b.Y, W: b.W + rowRadius, H: b.H}, rowRadius, fill)
		c.Paint.PopClip()
	}
	c.Paint.Fill(geom.Rect{X: b.X, Y: b.Y, W: groupRuleWidth, H: b.H}, 0, theme.WithAlpha(c.Theme.Tint, groupRuleAlpha))
	b.X, b.W = b.X+groupRuleWidth, b.W-groupRuleWidth
	return b
}
