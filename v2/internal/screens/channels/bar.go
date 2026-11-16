package channels

import (
	"image/color"
	"slices"

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
	headRoleSize    = 11.52
	headRoleLine    = 12.67
	// A banner makes the head taller by headBannerExtra and moves the list down by headListShift; its scrim runs from headScrimTop
	// at the top to headScrimMid at headScrimAt of the way down and to nothing at the bottom, and the name has a shadow.
	headBannerExtra = 30.4
	headListShift   = 22.4
	headScrimAt     = 0.7
	headScrimTop    = 158
	headScrimMid    = 26
	headShadowDrop  = 1
	headShadowAlpha = 179
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
	name, role := s.serverTitle(), s.ownRole(c)
	if l.narrow && !s.drawer.open {
		role = ""
	}
	badge := geom.Rect{X: l.head.X + layoutPadLeft, Y: l.head.Y + headBadgeTop, W: headBadge, H: headBadge}
	ink, shadow := c.Theme.Text, false
	if banner := s.drawHeadBanner(c, l); banner {
		ink, shadow = color.RGBA{255, 255, 255, 255}, true
	} else {
		c.Paint.Fill(l.head, 0, c.Theme.Bg)
		edge := c.Hairline()
		c.Paint.Fill(geom.Rect{X: l.head.X, Y: l.head.Bottom() - edge, W: l.head.W, H: edge}, 0, c.Theme.Border)
	}

	s.drawHeadFace(c, badge, name)
	nameStyle := paint.TextStyle{Size: headNameSize, Weight: paint.Bold, Spacing: headNameSize * 0.02}
	top := badge.Y + (headTextHeight-headNameLine)/2
	if role != "" {
		top = badge.Y + (headTextHeight-headNameLine-headRoleLine)/2
	}
	clip := geom.Rect{X: badge.Right(), Y: l.head.Y, W: l.head.Right() - badge.Right() - 14.4, H: l.head.H}
	x := badge.Right() + headGap
	if shadow {
		c.Paint.TextIn(clip, name, x, top+headShadowDrop, headNameLine, nameStyle, color.RGBA{A: headShadowAlpha})
	}
	c.Paint.TextIn(clip, name, x, top, headNameLine, nameStyle, ink)
	if role != "" {
		roleStyle := paint.TextStyle{Size: headRoleSize, Weight: paint.Regular}
		tone := c.Theme.Muted
		if shadow {
			tone = ink
			c.Paint.TextIn(clip, role, x, top+headNameLine+headShadowDrop, headRoleLine, roleStyle, color.RGBA{A: headShadowAlpha})
		}
		c.Paint.TextIn(clip, role, x, top+headNameLine, headRoleLine, roleStyle, tone)
	}
}

// drawHeadBanner paints the server's banner behind the head, with the scrim that keeps its name readable, and says whether there was one.
func (s *Screen) drawHeadBanner(c *widget.Context, l layout) bool {
	if l.banner == "" || c.Faces == nil {
		return false
	}
	pic := c.Paint.Sized(paint.Cover, l.banner, c.Paint.PixelSize(l.head.W), c.Paint.PixelSize(l.head.H), c.Faces)
	c.Paint.Fill(l.head, 0, c.Theme.Surface2)
	if !c.Paint.DrawSized(pic, l.head, 1) {
		return true
	}
	upper := geom.Rect{X: l.head.X, Y: l.head.Y, W: l.head.W, H: l.head.H * headScrimAt}
	lower := geom.Rect{X: l.head.X, Y: upper.Bottom(), W: l.head.W, H: l.head.H - upper.H}
	top, mid, none := color.RGBA{A: headScrimTop}, color.RGBA{A: headScrimMid}, color.RGBA{}
	c.Paint.Quad4(upper, top, top, mid, mid)
	c.Paint.Quad4(lower, mid, mid, none, none)
	return true
}

// drawHeadFace is the server's logo in the head, or its initial when it has none.
func (s *Screen) drawHeadFace(c *widget.Context, badge geom.Rect, name string) {
	if hash := s.Session.State().Server.LogoHash(); hash != "" && c.Faces != nil {
		pic := c.Paint.Sized(paint.Cover, hash, c.Paint.PixelSize(badge.W), c.Paint.PixelSize(badge.H), c.Faces)
		if c.Paint.DrawSizedRounded(pic, badge, headBadgeRadius, 1) {
			return
		}
	}
	widget.ServerBadge(c, badge, name)
}

func (s *Screen) drawColumnLines(c *widget.Context, l layout) {
	line := theme.WithAlpha(c.Theme.Tint, 0.08)
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: l.side.Right() - edge, Y: l.side.Y, W: edge, H: l.side.H}, 0, line)
	if l.members.W > 0 {
		c.Paint.Fill(geom.Rect{X: l.members.X, Y: l.members.Y, W: edge, H: l.members.H}, 0, line)
	}
}

// reserveBanner gives the head the room of the server's banner, when it has one, and moves the channel list down to leave it.
func (s *Screen) reserveBanner(l *layout) {
	hash := s.Session.State().Server.BannerHash()
	l.banner = hash
	if hash == "" {
		return
	}
	l.head.H += headBannerExtra
	l.side.Y += headListShift
	l.side.H -= headListShift
}

// ownRole is what to show under the server's name: owner, super admin, or the role held highest.
func (s *Screen) ownRole(c *widget.Context) string {
	st := s.Session.State()
	if role := st.Me.Role; role == "owner" || role == "admin" {
		return c.T("roles." + role)
	}
	for _, role := range st.Roles {
		if slices.Contains(st.Me.Roles, role.ID) {
			return role.Name
		}
	}
	return ""
}
