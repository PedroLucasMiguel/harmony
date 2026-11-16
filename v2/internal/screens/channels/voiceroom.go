package channels

import (
	"strconv"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/raw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	rosterRowHeight = 40.2
	rosterPadX      = 8
	rosterPadY      = 7.2
	rosterGap       = 9.6
	rosterAvatar    = 25.8
	rosterFont      = 11.7504
	rosterNameSize  = 16.32
	rosterCountGap  = 9.6
	emptyAlpha      = 0.6
	emptySize       = 14
)

func (s *Screen) drawMain(c *widget.Context, l layout, m model) {
	if s.forumOpen() {
		s.Session.SetViewersPaused(true)
		s.call.release()
		s.drawForum(c, l.main, m)
		return
	}
	if s.chat.channel != 0 {
		s.Session.SetViewersPaused(true)
		s.call.release()
		s.drawChat(c, l.main, m)
		return
	}
	if m.joined == nil {
		text := c.T("voice_idle.pick_a_voice_channel")
		style := paint.TextStyle{Size: emptySize, Weight: paint.Regular}
		width := c.Paint.TextWidth(text, style)
		line := float32(emptySize * 1.5)
		c.Paint.Text(text, l.main.X+(l.main.W-width)/2, l.main.Y+(l.main.H-line)/2, line, style, theme.WithAlpha(c.Theme.Text, emptyAlpha))
		return
	}
	streaming := len(m.streams) > 0
	s.Session.SetViewersPaused(!streaming || s.Settings.PauseHiddenCameras && raw.IsWindowMinimized())
	if streaming {
		s.drawStage(c, l.main, m)
		return
	}
	s.call.release()
	people := " people"
	if len(m.roster) == 1 {
		people = " person"
	}
	widget.Heading{Title: m.joined.Name, Count: strconv.Itoa(len(m.roster)) + people, CountGap: rosterCountGap}.Draw(c, geom.Rect{X: l.main.X, Y: l.main.Y, W: l.main.W, H: channelHeadH})

	rows := make([]widget.Component, len(m.roster))
	for i, member := range m.roster {
		rows[i] = rosterRow{screen: s, member: member, model: m, c: c}
	}
	s.rosterScroll.Child = widget.Col(0, rows...)
	s.rosterScroll.Draw(c, geom.Rect{X: l.main.X, Y: l.main.Y + channelHeadH, W: l.main.W, H: l.main.H - channelHeadH})
}

// rosterRow is one person in the room being shown.
type rosterRow struct {
	screen *Screen
	member hclient.Member
	model  model
	c      *widget.Context
}

func (r rosterRow) Measure(_ *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: rosterRowHeight}
}

func (r rosterRow) Draw(c *widget.Context, b geom.Rect) {
	if c.Hovered(b) {
		c.Paint.Fill(b, rowRadius, theme.WithAlpha(c.Theme.Tint, 0.05))
		if c.In.RightPressed && r.member.Mid != r.model.state.MyMid {
			c.Claim()
			r.screen.openPeerMenu(c, r.model.state.Joined, r.member.Mid)
		}
		if c.Clicked(b) && c.OpenProfile != nil {
			c.Claim()
			c.OpenProfile(r.member.UserID, b)
		}
	}
	if c.People != nil {
		if e := c.People.ByID(r.member.UserID); e != nil {
			c.DrawBannerStrip(e.BannerHash, e.BannerDim, b, rowRadius, c.Theme.Bg)
		}
	}
	avatar := widget.Avatar{ID: r.member.UserID, Name: r.member.Nickname, Size: rosterAvatar, Font: rosterFont, Speaking: r.screen.speaking(r.model, r.member)}
	avatar.Draw(c, geom.Rect{X: b.X + rosterPadX, Y: b.Y + (b.H-rosterAvatar)/2, W: rosterAvatar, H: rosterAvatar})
	name := r.member.Nickname
	if r.member.Mid == r.model.state.MyMid {
		name += " (you)"
	}
	x := b.X + rosterPadX + rosterAvatar + rosterGap
	line := float32(rosterNameSize * 1.5)
	style := paint.TextStyle{Size: rosterNameSize, Weight: paint.Regular}
	look := c.NameStyle(r.member.UserID, "")
	if clip := (geom.Rect{X: x, Y: b.Y, W: b.Right() - rosterPadX - x, H: b.H}); x+c.NameWidth(name, look, style) > clip.Right() {
		c.Paint.PushClip(clip)
		defer c.Paint.PopClip()
	}
	c.DrawName(name, look, x, b.Y+rosterPadY, line, style, c.Theme.Text)
}
