package channels

import (
	"harmony/v2/internal/screens/serveradmin"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	barPadding      = 20
	barButtonGap    = 3.9
	headBadge       = 30
	headBadgeTop    = 14.8
	headBadgeRadius = 8
	headGap         = 9.6
	headNameSize    = 15.2
	headNameLine    = 17.48
	headTextHeight  = 30.4
)

// barButtons are the top bar's two buttons, made once.
type barButtons struct{ server, members, signOut widget.Button }

func (s *Screen) drawBar(c *widget.Context, l layout, m model) {
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: l.bar.X, Y: l.bar.Bottom() - edge, W: l.bar.W, H: edge}, 0, c.Theme.Border)

	bar := &s.bar
	if bar.members.OnClick == nil {
		bar.members = widget.Button{Icon: "users", Variant: widget.Ghost, Small: true, OnClick: func() {
			s.Settings.ShowMembers = !s.Settings.ShowMembers
			s.Settings.Save()
		}}
		bar.signOut = widget.Button{Icon: "sign-out", Variant: widget.Ghost, Small: true, OnClick: s.OnSignOut}
		bar.server = widget.Button{Icon: "gear-six", Variant: widget.Ghost, Small: true, OnClick: func() { s.OnServerDialog(serveradmin.Target{}) }}
	}
	bar.members.Active = s.Settings.ShowMembers
	x := l.bar.Right() - barPadding
	buttons, shown := [...]*widget.Button{&bar.signOut, &bar.members, &bar.server}, 2
	if m.state.Actor.CanAdminister() {
		shown = 3
	}
	for _, b := range buttons[:shown] {
		size := b.Measure(c, 0)
		x -= size.W
		b.Draw(c, geom.Rect{X: x, Y: l.bar.Y + (barHeight-edge-size.H)/2, W: size.W, H: size.H})
		x -= barButtonGap
	}
}

func (s *Screen) drawServerHead(c *widget.Context, l layout) {
	c.Paint.Fill(l.head, 0, c.Theme.Bg)
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: l.head.X, Y: l.head.Bottom() - edge, W: l.head.W, H: edge}, 0, c.Theme.Border)

	name := s.serverTitle()
	badge := geom.Rect{X: l.head.X + layoutPadLeft, Y: l.head.Y + headBadgeTop, W: headBadge, H: headBadge}
	widget.ServerBadge(c, badge, name)
	nameStyle := paint.TextStyle{Size: headNameSize, Weight: paint.Bold, Spacing: headNameSize * 0.02}
	top := badge.Y + (headTextHeight-headNameLine)/2
	c.Paint.TextIn(geom.Rect{X: badge.Right(), Y: l.head.Y, W: l.head.Right() - badge.Right() - 14.4, H: l.head.H}, name, badge.Right()+headGap, top, headNameLine, nameStyle, c.Theme.Text)
}

func (s *Screen) drawColumnLines(c *widget.Context, l layout) {
	line := theme.WithAlpha(c.Theme.Tint, 0.08)
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: l.side.Right() - edge, Y: l.side.Y, W: edge, H: l.side.H}, 0, line)
	if l.members.W > 0 {
		c.Paint.Fill(geom.Rect{X: l.members.X, Y: l.members.Y, W: edge, H: l.members.H}, 0, line)
	}
}
