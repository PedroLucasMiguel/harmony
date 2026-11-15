package channels

import (
	"slices"
	"strconv"
	"strings"

	"harmony/v2/internal/app"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	membersPadLeft  = 12.8
	searchHeight    = 33.3
	searchGap       = 8
	searchInset     = 6.4
	memberRowH      = 29
	memberRowPadX   = 6.4
	memberRowGap    = 8
	memberRowAvatar = 15.5
	memberRowFont   = 8.4
	memberRowName   = 14
	sectionSize     = 11.2
	sectionLine     = 16.8
	sectionTop      = 14.4
	sectionTopFirst = 4.8
	sectionBottom   = 4
	sectionSpacing  = 0.06
	offlineAlpha    = 0.45
	dotSize         = 11.2
	dotDX           = 5.9
	dotDY           = 3.1
)

func (s *Screen) drawMembers(c *widget.Context, l layout, m model) {
	inner := geom.Rect{X: l.members.X + c.Hairline() + membersPadLeft, Y: l.members.Y, W: l.members.W - c.Hairline() - membersPadLeft, H: l.members.H}
	list := &s.people
	list.use(s, c, m)
	widget.Heading{Title: c.T("member_list.members"), Count: list.count, CountGap: 6.4}.Draw(c, geom.Rect{X: inner.X, Y: inner.Y, W: inner.W, H: channelHeadH})

	s.membersSearch.Box = true
	s.membersSearch.Placeholder = c.T("members.search")
	searchTop := inner.Y + channelHeadH
	s.membersSearch.Draw(c, geom.Rect{X: inner.X, Y: searchTop, W: inner.W - searchInset, H: searchHeight})

	s.memberScroll.Child = list
	top := searchTop + searchHeight + searchGap
	s.memberScroll.Draw(c, geom.Rect{X: inner.X, Y: top, W: inner.W, H: inner.Bottom() - top})
}

type member struct {
	id       int
	name     string
	presence widget.Presence
}

// memberList is the members column's contents: who is on and who is not, by name, for the people matching the search.
// What it holds is made again only when the roster, the presence, the search or the language changes.
type memberList struct {
	s                          *Screen
	state                      *app.State
	query                      string
	strings                    *i18n.Bundle
	people, offline            []member
	count, onlineText, offText string
}

func (l *memberList) use(s *Screen, c *widget.Context, m model) {
	query := strings.TrimSpace(s.membersSearch.Value)
	l.s = s
	if l.state == m.state && l.query == query && l.strings == c.Strings {
		return
	}
	l.state, l.query, l.strings = m.state, query, c.Strings
	l.people, l.offline = s.sortMembers(l.people[:0], l.offline[:0], m, query)
	total := len(l.people) + len(l.offline)
	l.count = strconv.Itoa(len(l.people)) + " of " + strconv.Itoa(total)
	if query != "" {
		l.count = c.T("members.found", "count", strconv.Itoa(total), "total", strconv.Itoa(len(m.state.Members)))
	}
	l.onlineText = c.T("members.online", "count", strconv.Itoa(len(l.people)))
	l.offText = c.T("members.offline", "count", strconv.Itoa(len(l.offline)))
}

// sortMembers splits the people who match the search into who is on and who is not, each by name.
func (s *Screen) sortMembers(online, offline []member, m model, query string) ([]member, []member) {
	query = strings.ToLower(query)
	for _, account := range m.state.Members {
		if query != "" && !strings.Contains(strings.ToLower(account.Name()), query) {
			continue
		}
		presence, on := m.online[account.ID]
		if on {
			online = append(online, member{account.ID, account.Name(), presence})
		} else {
			offline = append(offline, member{account.ID, account.Name(), widget.Offline})
		}
	}
	byName := func(a, b member) int { return strings.Compare(strings.ToLower(a.name), strings.ToLower(b.name)) }
	slices.SortFunc(online, byName)
	slices.SortFunc(offline, byName)
	return online, offline
}

func (l *memberList) Measure(_ *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: l.walk(nil, geom.Rect{W: maxWidth})}
}

func (l *memberList) Draw(c *widget.Context, r geom.Rect) { l.walk(c, r) }

// walk measures the sections, or with c also draws them, and returns their height.
func (l *memberList) walk(c *widget.Context, r geom.Rect) float32 {
	y := r.Y
	y = l.section(c, r, y, l.onlineText, l.people, true)
	y = l.section(c, r, y, l.offText, l.offline, y == r.Y)
	return y - r.Y
}

func (l *memberList) section(c *widget.Context, r geom.Rect, y float32, title string, people []member, first bool) float32 {
	if len(people) == 0 {
		return y
	}
	head := sectionHead{title: title, first: first}
	if c != nil {
		head.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: head.height()})
	}
	y += head.height()
	for _, p := range people {
		if c != nil {
			memberRow{member: p, screen: l.s}.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: memberRowH})
		}
		y += memberRowH
	}
	return y
}

type sectionHead struct {
	title string
	first bool
}

func (h sectionHead) top() float32 {
	if h.first {
		return sectionTopFirst
	}
	return sectionTop
}

func (h sectionHead) height() float32 { return h.top() + sectionLine + sectionBottom }

func (h sectionHead) Draw(c *widget.Context, b geom.Rect) {
	style := paint.TextStyle{Size: sectionSize, Weight: paint.Bold, Spacing: sectionSize * sectionSpacing}
	c.Paint.Text(widget.Upper(h.title), b.X+memberRowPadX, b.Y+h.top(), sectionLine, style, c.Theme.Muted)
}

const offlineColoredAlpha = 0.8

type memberRow struct {
	member member
	screen *Screen
}

func (r memberRow) Draw(c *widget.Context, b geom.Rect) {
	if !c.Paint.Visible(b) {
		return
	}
	if c.Hovered(b) {
		c.Paint.Fill(b, rowRadius, theme.WithAlpha(c.Theme.Tint, hoverAlpha))
		if c.In.RightPressed {
			r.screen.openMemberMenu(c, r.member.id, r.member.name)
		}
		if c.Clicked(b) && c.OpenProfile != nil {
			c.Claim()
			c.OpenProfile(r.member.id, b)
		}
	}
	off := r.member.presence == widget.Offline
	if c.People != nil {
		if e := c.People.ByID(r.member.id); e != nil {
			c.DrawBannerStrip(e.BannerHash, e.BannerDim, b, rowRadius, c.Theme.Bg)
		}
	}
	avatar := widget.Avatar{ID: r.member.id, Name: r.member.name, Size: memberRowAvatar, Font: memberRowFont, Dim: off}
	if !off {
		avatar.Dot = widget.AvatarDot{Presence: r.member.presence, Size: dotSize, Ring: 2 * c.Hairline(), Edge: c.Theme.Bg, DX: dotDX, DY: dotDY}
	}
	avatar.Draw(c, geom.Rect{X: b.X + memberRowPadX, Y: b.Y + (b.H-memberRowAvatar)/2, W: memberRowAvatar, H: memberRowAvatar})
	ink := c.Theme.Text
	if off {
		ink = theme.WithAlpha(ink, offlineAlpha)
	}
	x := b.X + memberRowPadX + memberRowAvatar + 2.94 + memberRowGap
	line := float32(memberRowName * 1.5)
	clip := geom.Rect{X: x, Y: b.Y, W: b.Right() - memberRowPadX - x, H: b.H}
	if role := r.role(c); role != "" {
		icon := widget.RoleIcon{Owner: role == "owner"}
		size := icon.Measure(c, 0)
		icon.Draw(c, geom.Rect{X: clip.Right() - size.W, Y: b.Y, W: size.W, H: b.H})
		clip.W -= size.W + memberRowGap
	}
	style := paint.TextStyle{Size: memberRowName, Weight: paint.Regular}
	look := c.NameStyle(r.member.id, r.member.name)
	if off && look != nil && look.Kind != people.Plain {
		ink = theme.WithAlpha(c.Theme.Text, offlineColoredAlpha)
	}
	if x+c.NameWidth(r.member.name, look, style) > clip.Right() {
		c.Paint.PushClip(clip)
		defer c.Paint.PopClip()
	}
	c.DrawName(r.member.name, look, x, b.Y+(b.H-line)/2, line, style, ink)
}

// role is "owner" or "admin" for the people who get an icon at the end of their row, and empty for everybody else.
func (r memberRow) role(c *widget.Context) string {
	if c.People == nil {
		return ""
	}
	if e := c.People.ByID(r.member.id); e != nil && (e.Role == "owner" || e.Role == "admin") {
		return e.Role
	}
	return ""
}
