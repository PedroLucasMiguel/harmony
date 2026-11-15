package channels

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	stripPadLeft   = 14.4
	stripPadTop    = 9.6
	faceSize       = 38.5
	selfAvatar     = 35.3
	selfAvatarPad  = 1.6
	selfFont       = 16.8
	selfDot        = 14.4
	selfDotOffset  = 4.6
	identityGap    = 11.2
	identityPadX   = 3.2
	identityTop    = 3.2
	selfNameSize   = 15.2
	selfNameLine   = 18.24
	selfStatusSize = 11.52
	selfStatusLine = 13.824
	actionsRight   = 16.9
	actionsHeight  = 28.8
	caretSize      = 13.44
	caretPadX      = 0.8
	caretOverlap   = 1.6
	statusDimAlpha = 0.6
)

func (s *Screen) drawSelfStrip(c *widget.Context, l layout, m model) {
	r := l.strip
	c.Paint.Fill(r, 0, c.Theme.Surface)
	edge := c.Hairline()
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: edge}, 0, c.Theme.Border)

	top := r.Y + edge + stripPadTop
	me := m.state.Me
	name := me.DisplayName
	if name == "" {
		name = me.Nickname
	}
	presence, on := m.online[me.ID]
	if !on {
		presence = widget.Online
	}
	presence, hidden := s.ownPresence(presence)
	avatar := widget.Avatar{
		Name: name, Size: selfAvatar, Font: selfFont,
		Dot: widget.AvatarDot{Presence: presence, Size: selfDot, Ring: 2 * edge, Edge: c.Theme.Surface, DX: selfDotOffset, DY: selfDotOffset},
	}
	face := geom.Rect{X: r.X + stripPadLeft + selfAvatarPad, Y: top + selfAvatarPad, W: selfAvatar, H: selfAvatar}
	avatar.Draw(c, face)
	s.drawStatusDot(c, face)

	textX := r.X + stripPadLeft + faceSize + identityGap + identityPadX
	textTop := top + identityTop
	c.Paint.Text(name, textX, textTop, selfNameLine, paint.TextStyle{Size: selfNameSize, Weight: paint.Bold}, c.Theme.Text)
	status, ink := c.T("app.online"), theme.WithAlpha(c.Theme.Text, statusDimAlpha)
	switch {
	case m.joined != nil:
		status, ink = c.T("app.in_voice"), c.Theme.Live
	case hidden != "":
		status = c.T("status." + hidden)
	case presence == widget.Idle:
		status = c.T("status.idle")
	case presence == widget.DoNotDisturb:
		status = c.T("status.dnd")
	}
	c.Paint.Text(status, textX, textTop+selfNameLine, selfStatusLine, paint.TextStyle{Size: selfStatusSize, Weight: paint.Regular}, ink)

	s.drawStripActions(c, r, top, m)
}

func (s *Screen) drawStripActions(c *widget.Context, r geom.Rect, top float32, m model) {
	s.wireStrip(c)
	inCall := m.joined != nil
	mic := widget.GlyphButton{Icon: "microphone", On: m.state.Muted, Disabled: !inCall, OnClick: s.strip.mute}
	if m.state.Muted {
		mic.Icon = "microphone-slash"
	}
	deafen := widget.GlyphButton{Icon: "headphones", On: m.state.Deafened, Disabled: !inCall, OnClick: s.strip.deafen}
	if m.state.Deafened {
		deafen.Icon = "speaker-slash"
	}
	gear := widget.GlyphButton{Icon: "gear-six", OnClick: s.OnSettings}

	y := top + (faceSize-actionsHeight)/2
	x := r.Right() - actionsRight
	x -= gear.Measure(c, 0).W
	gear.Draw(c, geom.Rect{X: x, Y: y, W: gear.Measure(c, 0).W, H: actionsHeight})
	x = s.drawAudioControl(c, audioOutput, deafen, x, y)
	s.drawAudioControl(c, audioInput, mic, x, y)
	s.showAudioMenu(c)
}

// drawAudioControl draws a button with its menu arrow to the left of x, and returns where it starts.
func (s *Screen) drawAudioControl(c *widget.Context, kind audioKind, button widget.GlyphButton, x, y float32) float32 {
	open := s.audio.menu.IsOpen() && s.audio.kind == kind
	caret := widget.GlyphButton{Icon: "caret-up", Size: caretSize, PadX: caretPadX, PadY: glyphPad, Faint: !open, OnClick: s.strip.menu[kind]}
	if open {
		caret.Icon = "caret-down"
	}
	caretBox, buttonBox := caret.Measure(c, 0), button.Measure(c, 0)
	caretRect := geom.Rect{X: x - caretBox.W, Y: y + (actionsHeight-caretBox.H)/2, W: caretBox.W, H: caretBox.H}
	buttonRect := geom.Rect{X: caretRect.X + caretOverlap - buttonBox.W, Y: y, W: buttonBox.W, H: actionsHeight}
	group := geom.Rect{X: buttonRect.X, Y: y, W: caretRect.Right() - buttonRect.X, H: actionsHeight}
	caret.Draw(c, caretRect)
	button.Draw(c, buttonRect)
	if c.In.RightPressed && c.Hovered(group) {
		s.openAudioMenu(c, kind)
	}
	if s.audio.kind == kind {
		s.audio.anchor, s.audio.trigger = group, caretRect
	}
	return buttonRect.X
}

const glyphPad = 4.8

// stripActions are what the microphone and headphone buttons do, made once; they read the state when pressed.
type stripActions struct {
	mute, deafen func()
	menu         [audioOutput + 1]func()
}

func (s *Screen) wireStrip(c *widget.Context) {
	if s.strip.mute != nil {
		return
	}
	s.strip.mute = func() { s.Session.SetMuted(!s.seen.state.Muted) }
	s.strip.deafen = func() { s.Session.SetDeafened(!s.seen.state.Deafened) }
	s.strip.menu[audioInput] = func() { s.toggleAudioMenu(c, audioInput) }
	s.strip.menu[audioOutput] = func() { s.toggleAudioMenu(c, audioOutput) }
}

// serverTitle is the name the server gave itself, or what is known of it from the saved server.
func (s *Screen) serverTitle() string {
	if name := s.Session.ServerName(); name != "" {
		return name
	}
	return s.Server.Title()
}
