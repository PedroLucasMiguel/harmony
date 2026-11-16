package channels

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	drawerShare   = 0.85
	drawerMax     = 340
	drawerScrim   = 128
	menuWidth     = 36
	menuHeight    = 31.7
	barReserve    = 150
	menuButtonGap = 6
)

// drawerState is the channel list as a drawer, which is what it becomes in a narrow window.
type drawerState struct{ open bool }

// narrowLayout turns the layout into the narrow one when the window is narrow: the channels column leaves the grid for a drawer over the stage, which then has the whole width.
func (s *Screen) narrowLayout(l *layout) {
	b := l.bounds
	l.narrow = b.W < narrowWidth
	if !l.narrow {
		s.drawer.open = false
		return
	}
	body := geom.Rect{X: b.X + layoutPadLeft, Y: b.Y + barHeight + layoutPadding, W: b.W - layoutPadLeft - layoutPadding, H: b.H - barHeight - 2*layoutPadding}
	l.members = geom.Rect{}
	l.banner = ""
	l.main = body
	width := min(drawerShare*b.W, drawerMax)
	l.drawer = geom.Rect{X: b.X, Y: b.Y, W: width, H: b.H}
	if s.drawer.open {
		l.side = geom.Rect{X: body.X, Y: body.Y, W: width - layoutPadLeft, H: body.H}
		l.head = geom.Rect{X: b.X, Y: b.Y, W: width - 1, H: barHeight}
		s.reserveBanner(l)
		l.strip = geom.Rect{X: b.X, Y: b.Bottom() - stripHeight, W: width, H: stripHeight}
		return
	}
	l.head = geom.Rect{X: b.X + menuWidth + menuButtonGap, Y: b.Y, W: max(0, b.W-menuWidth-menuButtonGap-barReserve), H: barHeight}
}

// drawNarrow draws the screen of a narrow window: the stage and the bar over the whole width, and the channel list over them in its drawer when it is open.
func (s *Screen) drawNarrow(c *widget.Context, l layout, m model) {
	open := s.drawer.open
	draw := func() {
		s.drawBar(c, l, m)
		s.drawMain(c, l, m)
		if !open {
			s.drawServerHead(c, l)
			s.drawMenuButton(c, l)
		}
	}
	if !open {
		draw()
		return
	}
	c.Frozen(draw)
	before, _ := s.here()
	c.Layer(&s.drawer)
	if c.EscapeFor(&s.drawer) {
		s.drawer.open = false
	}
	if c.Clicked(l.bounds) && !c.Hovered(l.drawer) {
		c.Claim()
		s.drawer.open = false
	}
	c.Paint.Fill(l.bounds, 0, color.RGBA{A: drawerScrim})
	c.Paint.Shadow(l.drawer, 0, 0, 32, color.RGBA{A: drawerScrim})
	c.Paint.Fill(l.drawer, 0, c.Theme.Bg)
	c.Popup(l.drawer)
	s.drawChannelList(c, l, m)
	s.drawServerHead(c, l)
	s.drawVoicePanel(c, l, m)
	s.drawSelfStrip(c, l, m)
	if after, _ := s.here(); after != before {
		s.drawer.open = false
	}
}

// drawMenuButton is the button at the left of the bar that opens the drawer.
func (s *Screen) drawMenuButton(c *widget.Context, l layout) {
	r := geom.Rect{X: l.bounds.X + layoutPadLeft, Y: l.bounds.Y + (barHeight-menuHeight)/2, W: menuWidth, H: menuHeight}
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(r, 8, theme.WithAlpha(c.Theme.Tint, 0.1))
		if c.In.Pressed {
			c.Claim()
			s.drawer.open = true
		}
	}
	c.Paint.Icon("list", geom.Rect{X: r.X + (r.W-18)/2, Y: r.Y + (r.H-18)/2, W: 18, H: 18}, c.Theme.Text)
}
