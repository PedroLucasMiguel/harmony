package channels

import (
	"strconv"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	panelPad       = 9.6
	panelRadius    = 10
	panelHeadH     = 32
	panelGap       = 8
	panelActionTop = 8.8
	panelActionGap = 4.8
	signalW        = 15.2
	signalH        = 12.8
	signalBar      = 3.52
	stateSize      = 13.6
	stateLine      = 17
	whereSize      = 12
	whereLine      = 15
)

// voicePanel is the call panel's buttons, made once.
type voicePanel struct {
	leave   widget.GlyphButton
	actions [4]widget.ActionButton
	flip    widget.ActionButton
	row     [5]*widget.ActionButton
}

func panelHeight(c *widget.Context, m model) float32 {
	action := widget.ActionButton{}.Measure(c, 0).H
	return 2*(c.Hairline()+panelPad) + panelHeadH + panelActionTop + action + musicStripExtra(c, m)
}

func (s *Screen) drawVoicePanel(c *widget.Context, l layout, m model) {
	if key := s.Session.TakeCameraNote(); key != "" {
		s.say(c.T(key))
	}
	if m.joined == nil {
		s.sound.Close()
		s.music.pop.Close()
		return
	}
	h := panelHeight(c, m)
	panel := geom.Rect{X: l.side.X, Y: l.side.Bottom() - dockReserve - panelMarginBot - h, W: l.side.W - sidePaddingRight - c.Hairline(), H: h}
	c.Paint.Fill(panel, panelRadius, c.Theme.Surface)
	c.Paint.Stroke(panel, panelRadius, c.Hairline(), c.Theme.Border)
	inner := panel.InsetAll(c.Hairline() + panelPad)

	down := s.Session.Reconnecting()
	s.drawSignal(c, geom.Rect{X: inner.X, Y: inner.Y + (panelHeadH-signalH)/2, W: signalW, H: signalH}, down)
	textX := inner.X + signalW + panelGap
	state, stateInk, whereInk := c.T("app.voice_connected"), c.Theme.Live, c.Theme.Muted
	if down {
		state, stateInk, whereInk = c.T("app.reconnecting"), c.Theme.Warn, c.Theme.Warn
	}
	c.Paint.Text(state, textX, inner.Y, stateLine, paint.TextStyle{Size: stateSize, Weight: paint.Bold}, stateInk)
	c.Paint.TextIn(geom.Rect{X: textX, Y: inner.Y, W: inner.Right() - textX - 40, H: panelHeadH}, m.joined.Name, textX, inner.Y+stateLine, whereLine, paint.TextStyle{Size: whereSize, Weight: paint.Regular}, whereInk)

	buttons := &s.panel
	if buttons.leave.OnClick == nil {
		buttons.leave = widget.GlyphButton{Icon: "phone-disconnect", Danger: true, OnClick: func() { go s.Session.Leave() }}
		buttons.actions = [4]widget.ActionButton{
			{Icon: "video-camera", OnClick: func() { go s.toggleCamera(s.seen.state.Camera) }},
			{Icon: "screencast", OnClick: func() { s.pressShare(s.seen.state.Sharing) }},
			{Icon: "music-notes", OnClick: s.sound.Toggle},
			{Icon: "playlist", OnClick: s.music.toggle},
		}
		buttons.flip = widget.ActionButton{Icon: "camera-rotate", OnClick: func() { go s.Session.SwitchCamera() }}
	}
	size := buttons.leave.Measure(c, 0)
	buttons.leave.Draw(c, geom.Rect{X: inner.Right() - size.W, Y: inner.Y + (panelHeadH-size.H)/2, W: size.W, H: size.H})

	flipShown := m.state.Camera && s.Session.CanSwitchCamera()
	buttons.flip.Disabled = s.Session.SwitchingCamera()
	row := buttons.row[:0]
	row = append(row, &buttons.actions[0])
	if flipShown {
		row = append(row, &buttons.flip)
	}
	row = append(row, &buttons.actions[1], &buttons.actions[2])
	soundAt := len(row) - 1
	if m.musicCan {
		row = append(row, &buttons.actions[3])
	}
	buttons.actions[0].On, buttons.actions[1].On, buttons.actions[2].On = m.state.Camera, m.state.Sharing, s.sound.IsOpen()
	width := (inner.W - float32(len(row)-1)*panelActionGap) / float32(len(row))
	top := inner.Y + panelHeadH + panelActionTop
	buttonH := buttons.actions[0].Measure(c, width).H
	slot := func(i int) geom.Rect {
		return geom.Rect{X: inner.X + float32(i)*(width+panelActionGap), Y: top, W: width, H: buttonH}
	}
	for i, a := range row {
		a.Draw(c, slot(i))
		if a == &buttons.actions[1] {
			s.showShareMenu(c, slot(i))
		}
	}
	s.drawSoundboard(c, slot(soundAt))
	s.drawMusic(c, m, geom.Rect{X: inner.X, Y: top + buttonH + musicStripGap, W: inner.W}, slot(soundAt+1))
}

func (s *Screen) toggleShare(sharing bool) {
	if sharing {
		s.Session.StopShare()
		return
	}
	if s.ShareHooks.Start != nil {
		s.fail(s.ShareHooks.Start())
	}
}

func (s *Screen) toggleCamera(on bool) {
	if on {
		s.Session.StopCamera()
		return
	}
	if s.ShareHooks.StartCamera != nil {
		s.fail(s.ShareHooks.StartCamera())
	}
}

const (
	pingGoodMs = 60
	pingBadMs  = 150
	signalOff  = 0.2
)

// drawSignal is the three rising bars that say how the connection to the room is: green when the relay is near, amber when it is far
// or not measured yet or being redialled, red past 150 ms. Held over, it says the round trip.
func (s *Screen) drawSignal(c *widget.Context, r geom.Rect, down bool) {
	ms, known := s.Session.Ping()
	lit, ink, tip := 3, c.Theme.Live, c.T("voice.measuring")
	switch {
	case down:
		lit, ink, tip = 1, c.Theme.Warn, c.T("voice.reconnecting")
	case !known:
		lit, ink = 2, c.Theme.Warn
	default:
		tip = c.T("voice.ms_to_relay", "ms", strconv.Itoa(ms))
		switch {
		case ms > pingBadMs:
			lit, ink = 1, c.Theme.DangerSoft
		case ms > pingGoodMs:
			lit, ink = 2, c.Theme.Warn
		}
	}
	off := theme.WithAlpha(c.Theme.Tint, signalOff)
	heights := [3]float32{0.4, 0.7, 1}
	for i, h := range heights {
		bar := ink
		if i >= lit {
			bar = off
		}
		x := r.X + float32(i)*(r.W-signalBar)/2
		c.Paint.Fill(geom.Rect{X: x, Y: r.Bottom() - r.H*h, W: signalBar, H: r.H * h}, 0, bar)
	}
	s.tip.Show(c, r, tip, 0)
}
