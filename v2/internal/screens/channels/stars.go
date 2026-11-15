package channels

import (
	"encoding/json"
	"image/color"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	starsPage     = 50
	starsPad      = 9.6
	starsGap      = 5.6
	starsCountPad = 3.2
	starsCountH   = 18
	starsSubH     = starsPad + 33.3 + starsGap + starsCountH
	starsMinimum  = 200
)

var starInk = color.RGBA{R: 0xf2, G: 0xb8, B: 0x4b, A: 255}

var starsCountStyle = paint.TextStyle{Size: 12, Weight: paint.Regular}

// starsPanel is the list behind the star in the header: the messages this person keeps for themselves.
type starsPanel struct {
	sheet  sheet
	column cardColumn
	query  widget.TextField
	more   widget.Button
	shown  int
	typed  string
	dirty  bool
	width  float32
	avail  float32
	zoom   float32
	total  int
	found  int

	c     *widget.Context
	s     *Screen
	model model
}

func (s *Screen) starScope(m model) string {
	if id := m.state.Me.ID; s.scope == "" || s.scopeUser != id {
		s.scope, s.scopeUser = store.StarScope(s.Server.URL, id), id
	}
	return s.scope
}

func (s *Screen) isStarred(m model, id int) bool { return s.Settings.Starred(s.starScope(m), id) }

func fold(text string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(text) {
		if !unicode.Is(unicode.Mn, r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

func hasWords(query, haystack string) bool {
	text := fold(haystack)
	for _, word := range strings.Fields(fold(query)) {
		if !strings.Contains(text, word) {
			return false
		}
	}
	return true
}

func starSnapshot(msg *hclient.ChatMessage) store.StarredMessage {
	snap := store.StarredMessage{
		ID: msg.ID, ChannelID: msg.ChannelID, UserID: msg.UserID, Nickname: msg.Nickname, Body: msg.Body, CreatedAt: msg.CreatedAt,
		EditedAt: msg.EditedAt, AttachmentHash: msg.AttachmentHash, AttachmentName: msg.AttachmentName,
		AttachmentBytes: msg.AttachmentBytes, MediaType: msg.MediaType, ThreadID: msg.ThreadID, Title: msg.Title,
	}
	if msg.Reply != nil {
		snap.Reply, _ = json.Marshal(msg.Reply)
	}
	return snap
}

func chatMessage(st store.StarredMessage) hclient.ChatMessage {
	return hclient.ChatMessage{
		ID: st.ID, ChannelID: st.ChannelID, UserID: st.UserID, Nickname: st.Nickname, Body: st.Body, CreatedAt: st.CreatedAt,
		EditedAt: st.EditedAt, AttachmentHash: st.AttachmentHash, AttachmentName: st.AttachmentName,
		AttachmentBytes: st.AttachmentBytes, MediaType: st.MediaType, ThreadID: st.ThreadID, Title: st.Title,
	}
}

// toggleStar stars a message, or takes its star away; the star is this person's alone, kept in the settings file.
func (s *Screen) toggleStar(m model, msg *hclient.ChatMessage) {
	scope := s.starScope(m)
	if s.Settings.Starred(scope, msg.ID) {
		s.Settings.RemoveStar(scope, msg.ID)
	} else if err := s.Settings.AddStar(scope, s.starSnapshotOf(msg)); err != nil {
		s.say(s.chat.find.c.T("stars.too_many"))
		return
	}
	s.Settings.Save()
	s.chat.find.stars.dirty = true
	s.fail(nil)
}

func (p *starsPanel) fit(avail float32) {
	c, s, m := p.c, p.s, p.model
	full := min(sheetWidth, c.Viewport.W-2*sheetMargin) - 2*(c.Hairline()+listPad)
	if !p.dirty && p.typed == p.query.Value && p.width == full && p.avail == avail && p.zoom == c.Paint.Zoom {
		return
	}
	if p.typed != p.query.Value {
		p.shown = starsPage
	}
	p.dirty, p.typed, p.width, p.avail, p.zoom = false, p.query.Value, full, avail, c.Paint.Zoom
	scope := s.starScope(m)
	list := s.Settings.StarList(scope)
	p.column.screen = s
	query := strings.TrimSpace(p.query.Value)
	p.total = len(list)
	p.column.layout(c, avail, full, func(width float32) {
		p.column.items = p.column.items[:0]
		p.found = 0
		for _, star := range list {
			msg := chatMessage(star.Message)
			channel := s.channelNamed(m, star.ChannelID)
			if query != "" {
				author := s.nameOf(m, msg.UserID, msg.Nickname)
				if !hasWords(query, strings.Join([]string{author, msg.Body, msg.AttachmentName, channel}, " ")) {
					continue
				}
			}
			p.found++
			if p.found > p.shown {
				continue
			}
			where := ""
			if channel != "" {
				where = "#" + channel
			}
			if star.Message.PostTitle != "" {
				where += " › " + star.Message.PostTitle
			}
			card := s.newCard(c, m, msg, where, width, false)
			id, channelID, thread := star.ID, star.ChannelID, msg.Thread()
			card.jump = func() { p.sheet.Close(); s.goToThread(channelID, id, thread) }
			card.action = func() { s.toggleStarByID(m, scope, id) }
			p.column.items = append(p.column.items, colItem{card: card})
		}
	})
	p.column.empty = c.T("stars.no_match")
	if p.total == 0 {
		p.column.empty = c.T("stars.none")
	}
	p.column.more = nil
	if p.found > p.shown {
		p.more.Label = c.T("stars.show_more", "count", strconv.Itoa(p.found-p.shown))
		p.more.Variant, p.more.Small = widget.Ghost, true
		p.more.OnClick = func() { p.shown += starsPage; p.dirty = true }
		p.column.more = &p.more
	}
}

func (s *Screen) toggleStarByID(m model, scope string, id int) {
	s.Settings.RemoveStar(scope, id)
	s.Settings.Save()
	s.chat.find.stars.dirty = true
}

func (s *Screen) drawStars(c *widget.Context, m model, button geom.Rect) {
	p := &s.chat.find.stars
	if p.shown == 0 {
		p.shown, p.dirty = starsPage, true
	}
	p.c, p.s, p.model = c, s, m
	if p.sheet.fit == nil {
		p.sheet.fit = p.fit
	}
	p.sheet.anchor = button
	p.sheet.title, p.sheet.icon, p.sheet.ink, p.sheet.dim = c.T("stars.title"), "star", starInk, false
	p.sheet.minimum, p.sheet.column, p.sheet.subH = starsMinimum, &p.column, starsSubH
	if p.sheet.sub == nil {
		p.sheet.sub = func(c *widget.Context, r geom.Rect) { s.drawStarsSub(c, r) }
	}
	p.sheet.show(c)
}

func (s *Screen) drawStarsSub(c *widget.Context, r geom.Rect) {
	p := &s.chat.find.stars
	p.query.Box = true
	p.query.Placeholder = c.T("stars.search")
	box := geom.Rect{X: r.X + starsPad, Y: r.Y + starsPad, W: r.W - 2*starsPad, H: 33.3}
	p.query.Draw(c, box)
	if p.query.Value != "" && drawClear(c, box) {
		p.query.SetValue("")
		p.query.RequestFocus()
	}
	var text string
	if strings.TrimSpace(p.query.Value) != "" {
		text = c.Strings.Plural("stars.found", p.found, "count", strconv.Itoa(p.found), "total", strconv.Itoa(p.total))
	} else {
		text = c.Strings.Plural("stars.count", p.total, "count", strconv.Itoa(p.total))
	}
	if p.total > 0 {
		c.Paint.Text(text, box.X+starsCountPad, box.Bottom()+starsGap, starsCountH, starsCountStyle, c.Theme.Muted)
	}
}

func (p *starsPanel) open() {
	p.sheet.Open()
	p.shown, p.dirty = starsPage, true
	p.query.RequestFocus()
}

// lit is the colour a tool in the hover badge takes while it is on, and nothing while it is off.
func lit(on bool, ink color.RGBA) color.RGBA {
	if on {
		return ink
	}
	return color.RGBA{}
}
