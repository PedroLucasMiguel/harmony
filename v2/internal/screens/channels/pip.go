package channels

import (
	"cmp"
	"slices"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	pipHold    = 1500 * time.Millisecond
	pipPick    = 12 * time.Second
	pipBarHigh = widget.StreamBarHeight
)

var (
	pipUsual = geom.Size{W: 380, H: 250}
	pipLeast = geom.Size{W: 220, H: 150}
)

// MiniHooks is how the window of streams asks the shell to make the whole app that window, and to take it back.
type MiniHooks struct {
	// Out makes the app the window of streams; In puts it back, and with stage also shows the streams on the stage.
	Out  func()
	In   func(stage bool)
	Move func()
	// Closed is the window being closed for now.
	Closed func()
}

// pipState is the picture in picture: one stream of the call at a time in a small window over the other pages, which one is
// the person's pick unless somebody with a camera on is talking.
type pipState struct {
	win       widget.Floating
	placed    bool
	dismissed bool
	mini      bool

	figures []app.Stream
	shown   int
	on      bool

	pick, auto  app.Stream
	picked      bool
	autoOn      bool
	autoUntil   time.Time
	pickedUntil time.Time

	view    streamView
	viewKey streamKey
	hasView bool
}

// stageHidden says whether something else than the call's streams is on the stage.
func (s *Screen) stageHidden() bool { return s.dm.page || s.forumOpen() || s.chat.channel != 0 }

// pipShows says whether the window can show a stream: somebody else's that is being watched.
func pipShows(st app.Stream) bool { return !st.Own && st.Watching }

// pipList lists the streams the window can show: the ones of other people that are being watched, in the order of the stage.
func (s *Screen) pipList(streams []app.Stream) []app.Stream {
	p := &s.pip
	p.figures = p.figures[:0]
	if !s.Settings.PictureInPicture {
		return p.figures
	}
	for _, st := range streams {
		if pipShows(st) {
			p.figures = append(p.figures, st)
		}
	}
	slices.SortFunc(p.figures, func(a, b app.Stream) int {
		return cmp.Or(cmp.Compare(a.Mid, b.Mid), cmp.Compare(a.Kind, b.Kind))
	})
	return p.figures
}

// PipReady says whether there is a window of streams to show, which is what the app being made that window needs.
func (s *Screen) PipReady() bool {
	if s.pip.dismissed || !s.Session.InVoice() {
		return false
	}
	return s.Settings.PictureInPicture && slices.ContainsFunc(s.Session.Streams(), pipShows)
}

// PipAuto says whether the window should take over the app by itself when it is minimised.
func (s *Screen) PipAuto() bool { return s.Settings.PipPopOut && s.PipReady() }

// PipRevive lets the window come back after it was closed for now.
func (s *Screen) PipRevive() { s.pip.dismissed = false }

// SetMini says that the whole app is the window of streams.
func (s *Screen) SetMini(on bool) { s.pip.mini = on }

// pipPrepare chooses what the window shows this frame and sets the streams that are decoded to match.
func (s *Screen) pipPrepare(m model) {
	p := &s.pip
	figures := s.pipList(m.streams)
	p.shown = -1
	if m.joined != nil && len(figures) > 0 {
		p.shown = s.pipChoose(m)
	}
	p.on = !p.dismissed && p.shown >= 0 && (p.mini || s.stageHidden())
	switch {
	case p.on:
		s.call.release()
		shown := figures[p.shown]
		s.Session.SetViewersPaused(false)
		s.Session.SetViewersOnly(shown.Mid, shown.Kind, true)
	case p.hasView:
		p.view.surface.Close()
		p.view, p.hasView = streamView{}, false
		fallthrough
	default:
		s.Session.SetViewersOnly(0, "", false)
	}
	if s.dm.page && !p.on {
		s.Session.SetViewersPaused(true)
	}
}

// pipChoose is the index of the stream to show: the camera of somebody talking while they talk and a moment after, else the
// pick. A pick made by hand rests the talker for a while, as stepping to a screen share while somebody chats on is a decision.
func (s *Screen) pipChoose(m model) int {
	p := &s.pip
	at := func(k app.Stream) int {
		return slices.IndexFunc(p.figures, func(f app.Stream) bool { return keyOf(f) == keyOf(k) })
	}
	if !p.picked || at(p.pick) < 0 {
		p.pick, p.picked = p.figures[0], true
	}
	if p.autoOn && at(p.auto) < 0 {
		p.autoOn = false
	}
	now := time.Now()
	if now.Before(p.pickedUntil) {
		p.autoOn = false
		redraw.After(p.pickedUntil.Sub(now))
	} else {
		var talking []app.Stream
		for _, f := range p.figures {
			if f.Kind == kindCamera && s.speaking(m, memberOf(m.roster, f.Mid)) {
				talking = append(talking, f)
			}
		}
		if len(talking) > 0 {
			chosen := talking[0]
			for _, f := range talking {
				if p.autoOn && keyOf(f) == keyOf(p.auto) {
					chosen = f
				}
			}
			p.auto, p.autoOn, p.autoUntil = chosen, true, now.Add(pipHold)
		} else if p.autoOn && now.After(p.autoUntil) {
			p.autoOn = false
		}
		if p.autoOn {
			redraw.After(p.autoUntil.Sub(now))
		}
	}
	if p.autoOn {
		return at(p.auto)
	}
	return at(p.pick)
}

func (s *Screen) pipStep(by int) {
	p := &s.pip
	if len(p.figures) < 2 {
		return
	}
	next := (p.shown + by + len(p.figures)) % len(p.figures)
	p.pick, p.picked, p.autoOn = p.figures[next], true, false
	p.pickedUntil = time.Now().Add(pipPick)
	redraw.Request()
}

// leaveToStage shows the call's streams on the stage again.
func (s *Screen) leaveToStage() {
	if s.dm.page {
		s.closeConversation()
		s.dm.page = false
		s.dm.menu.Close()
	}
	s.closeText()
	redraw.Request()
}

// drawPip floats the window over the page when it is wanted.
func (s *Screen) drawPip(c *widget.Context, page geom.Rect, m model) {
	p := &s.pip
	if !p.on || p.mini {
		return
	}
	if !p.placed {
		saved := s.Settings.PipRect
		p.win.Rect, p.placed = geom.Rect{X: saved.X, Y: saved.Y, W: saved.W, H: saved.H}, true
	}
	p.win.Fit(geom.Size{W: page.W, H: page.H}, pipUsual, pipLeast)
	c.Overlay(func() {
		if c.Modal() != nil {
			return
		}
		bar, body := p.win.Begin(c, page, pipBarHigh)
		barAct, tileAct := s.pipContent(c, m, bar, body, "arrow-square-out", 0)
		switch {
		case barAct == widget.BarGrab || tileAct == widget.TileClick:
			p.win.Move(c)
		case barAct == widget.BarPop && s.Mini.Out != nil:
			s.Mini.Out()
		}
		if p.win.End(c, page, pipLeast) {
			r := p.win.Rect
			s.Settings.PipRect = store.Rect{X: r.X, Y: r.Y, W: r.W, H: r.H}
			s.Settings.Save()
		}
	})
}

// DrawMini draws the window of streams over the whole of bounds, for an app that has become that window.
func (s *Screen) DrawMini(c *widget.Context, bounds geom.Rect, left float32) {
	m := s.read()
	s.watch.follow(s.Session, m.joined != nil)
	s.pipPrepare(m)
	p := &s.pip
	if !p.on {
		return
	}
	bar := geom.Rect{X: bounds.X, Y: bounds.Y, W: bounds.W, H: pipBarHigh}
	body := geom.Rect{X: bounds.X, Y: bounds.Y + pipBarHigh, W: bounds.W, H: max(0, bounds.H-pipBarHigh)}
	barAct, tileAct := s.pipContent(c, m, bar, body, "arrow-square-in", left)
	switch {
	case barAct == widget.BarGrab || tileAct == widget.TileClick:
		if s.Mini.Move != nil {
			s.Mini.Move()
		}
	case barAct == widget.BarPop && s.Mini.In != nil:
		s.Mini.In(false)
	}
}

// pipContent draws the bar and the stream under it and does what was pressed that is the same in the window and in the
// app made window; what is left is returned.
func (s *Screen) pipContent(c *widget.Context, m model, bar, body geom.Rect, popIcon string, left float32) (widget.BarAction, widget.TileAction) {
	p := &s.pip
	st := p.figures[p.shown]
	v := s.pipView(st)
	s.feed(c, st, v, body)

	note := ""
	if p.autoOn && keyOf(p.auto) == keyOf(st) {
		note = c.T("app.pip_talking", "name", st.Nick)
	}
	barAct := widget.StreamBar{Index: p.shown, Total: len(p.figures), Note: note, PopIcon: popIcon, Left: left}.Show(c, bar)

	member := memberOf(m.roster, st.Mid)
	tile := widget.VideoTile{
		Surface: &v.surface, Name: v.label, Face: st.Nick, Error: st.Err,
		Mirror: false, Preview: true,
		Speaking: s.speaking(m, member), Muted: member.Muted, ForceMuted: member.ForceMuted, Deafened: member.Deafened,
		Flat: true, Controls: true, NoClose: true, NoFullscreen: true,
	}
	s.tileSound(&tile, st, v)
	tileAct := tile.Show(c, body)
	if tileAct == widget.TileMute {
		s.toggleStreamMute(st)
	}

	switch barAct {
	case widget.BarPrev:
		s.pipStep(-1)
	case widget.BarNext:
		s.pipStep(1)
	case widget.BarStage:
		s.leaveToStage()
		if p.mini && s.Mini.In != nil {
			s.Mini.In(true)
		}
	case widget.BarClose:
		p.dismissed = true
		if p.mini && s.Mini.Closed != nil {
			s.Mini.Closed()
		}
		redraw.Request()
	}
	return barAct, tileAct
}

// pipView is the picture of the stream shown; the window keeps one, whichever stream it is on.
func (s *Screen) pipView(st app.Stream) *streamView {
	p := &s.pip
	key := keyOf(st)
	if !p.hasView || p.viewKey != key {
		p.view.surface.Close()
		p.view, p.viewKey, p.hasView = streamView{label: streamLabel(st), nick: st.Nick}, key, true
	}
	return &p.view
}
