package channels

import (
	"cmp"
	"slices"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	stageGap       = 8
	stripTileWidth = 200
	stripTileRatio = 9.0 / 16
	stripPadBottom = 2
	hudHold        = 2500 * time.Millisecond
	kindCamera     = "c"
	kindScreen     = "s"
)

type streamKey struct {
	mid  int
	kind string
}

// rank puts your own streams first and the ones that are not being watched last.
func rank(st app.Stream) int {
	switch {
	case st.Own:
		return 0
	case st.Watching:
		return 1
	}
	return 2
}

func keyOf(st app.Stream) streamKey { return streamKey{st.Mid, st.Kind} }

// streamView is what the window keeps for one stream: its texture, and its caption made once.
type streamView struct {
	surface widget.Surface
	nick    string
	label   string
	seen    uint64
	volume  widget.Slider
}

// callStage is the voice room's cameras and screen shares: all of them in a grid, or one in focus with the others in a
// strip under it, or one filling the window.
type callStage struct {
	views    map[streamKey]*streamView
	order    []app.Stream
	frame    uint64
	focus    streamKey
	focused  bool
	full     streamKey
	fullOn   bool
	stripX   float32
	lastMove time.Time
}

// streamLabel is the caption of a stream: whose it is and what it is.
func streamLabel(st app.Stream) string {
	kind := "camera"
	if st.Kind == kindScreen {
		kind = "screen"
	}
	who := st.Nick
	if st.Own {
		who = "you"
	}
	return who + " · " + kind
}

func (cs *callStage) view(st app.Stream) (v *streamView, created bool) {
	key := keyOf(st)
	v = cs.views[key]
	if v == nil {
		if cs.views == nil {
			cs.views = map[streamKey]*streamView{}
		}
		v, created = &streamView{}, true
		cs.views[key] = v
	}
	if v.nick != st.Nick || v.label == "" {
		v.nick, v.label = st.Nick, streamLabel(st)
	}
	v.seen = cs.frame
	return v, created
}

// prepare lists the streams in the order they are shown (yours first, then by member) and lets go of what has ended.
func (s *Screen) prepareStage(streams []app.Stream) {
	cs := &s.call
	cs.frame++
	cs.order = append(cs.order[:0], streams...)
	slices.SortFunc(cs.order, func(a, b app.Stream) int {
		return cmp.Or(cmp.Compare(rank(a), rank(b)), cmp.Compare(a.Mid, b.Mid), cmp.Compare(a.Kind, b.Kind))
	})
	for _, st := range cs.order {
		if _, created := cs.view(st); created && st.Own && st.Kind == kindCamera && s.Settings.CameraPreview && !st.Watching {
			go s.Session.Watch(st.Mid, st.Kind)
		}
	}
	for key, v := range cs.views {
		if v.seen != cs.frame {
			v.surface.Close()
			delete(cs.views, key)
		}
	}
	if cs.focused && cs.views[cs.focus] == nil {
		cs.focused = false
	}
	if cs.fullOn && cs.views[cs.full] == nil {
		cs.endFull()
	}
}

func (cs *callStage) release() {
	for _, v := range cs.views {
		v.surface.Close()
	}
	cs.endFull()
}

func (cs *callStage) endFull() {
	if cs.fullOn && rl.IsWindowFullscreen() {
		rl.ToggleBorderlessWindowed()
	}
	cs.fullOn = false
}

func (cs *callStage) startFull(key streamKey) {
	if !cs.fullOn {
		rl.ToggleBorderlessWindowed()
	}
	cs.full, cs.fullOn = key, true
	redraw.Request()
}

// drawStage shows every stream of the room in area.
func (s *Screen) drawStage(c *widget.Context, area geom.Rect, m model) {
	cs := &s.call
	s.prepareStage(m.streams)
	var focus *app.Stream
	if cs.focused {
		for i := range cs.order {
			if keyOf(cs.order[i]) == cs.focus {
				focus = &cs.order[i]
			}
		}
	}
	if cs.fullOn {
		s.drawFull(c, m)
	}
	if focus == nil {
		for i, st := range cs.order {
			s.showStream(c, st, m, widget.GridCell(i, len(cs.order), area, stageGap), false)
		}
		return
	}
	stripH := float32(stripTileWidth*stripTileRatio + stripPadBottom)
	big := geom.Rect{X: area.X, Y: area.Y, W: area.W, H: max(0, area.H-stripH-stageGap)}
	s.showStream(c, *focus, m, big, true)
	s.drawStrip(c, geom.Rect{X: area.X, Y: area.Bottom() - stripH, W: area.W, H: stripH}, m)
}

func (s *Screen) drawStrip(c *widget.Context, strip geom.Rect, m model) {
	cs := &s.call
	others := len(cs.order) - 1
	content := float32(others)*stripTileWidth + float32(max(0, others-1))*stageGap
	maxScroll := max(0, content-strip.W)
	if c.Hovered(strip) && c.In.Wheel != 0 {
		cs.stripX -= c.In.Wheel * stripTileWidth / 2
	}
	cs.stripX = min(max(cs.stripX, 0), maxScroll)
	c.Paint.PushClip(strip)
	x := strip.X - cs.stripX
	for _, st := range cs.order {
		if keyOf(st) == cs.focus {
			continue
		}
		r := geom.Rect{X: x, Y: strip.Y, W: stripTileWidth, H: stripTileWidth * stripTileRatio}
		if r.Right() > strip.X && r.X < strip.Right() {
			s.showStream(c, st, m, r, true)
		}
		x += stripTileWidth + stageGap
	}
	c.Paint.PopClip()
}

// showStream draws one stream's tile in r and does what was pressed on it.
func (s *Screen) showStream(c *widget.Context, st app.Stream, m model, r geom.Rect, compact bool) {
	cs := &s.call
	key := keyOf(st)
	v := cs.views[key]
	if !st.Own && !st.Watching {
		if (widget.GhostTile{Name: v.label, Hint: c.T("app.closed_click_to_watch_again")}).Show(c, r) {
			go s.Session.Watch(st.Mid, st.Kind)
		}
		return
	}
	s.feed(c, st, v, r)
	if !st.Own && c.In.RightPressed && c.Hovered(r) {
		s.openPeerMenu(c, m.state.Joined, st.Mid)
	}
	focused := cs.focused && cs.focus == key
	member := memberOf(m.roster, st.Mid)
	tile := widget.VideoTile{
		Surface: &v.surface, Name: v.label, Face: st.Nick, Error: st.Err,
		Own: st.Own, Mirror: st.Own && st.Kind == kindCamera, Preview: st.Watching,
		Speaking: s.speaking(m, member), Muted: member.Muted, ForceMuted: member.ForceMuted, Deafened: member.Deafened,
		Focused: focused, Compact: compact && !focused, Controls: focused,
	}
	if st.Own && st.Kind == kindScreen {
		tile.HiddenTitle, tile.HiddenText = c.T("app.preview_hidden"), c.T("preview.hidden_text")
	}
	s.tileSound(&tile, st, v)
	switch tile.Show(c, r) {
	case widget.TileMute:
		s.toggleStreamMute(st)
	case widget.TileMonitor:
		s.toggleShareMonitor()
	case widget.TileClick:
		cs.focus, cs.focused = key, !focused
		if st.Own && !st.Watching && cs.focused {
			go s.Session.Watch(st.Mid, st.Kind)
		}
	case widget.TileClose:
		go s.Session.Unwatch(st.Mid, st.Kind)
		cs.focused = cs.focused && !focused
	case widget.TileFullscreen:
		cs.startFull(key)
	case widget.TilePreview:
		s.togglePreview(st)
	}
}

// feed uploads the stream's newest picture and tells the decoder how big it is drawn.
func (s *Screen) feed(c *widget.Context, st app.Stream, v *streamView, r geom.Rect) {
	if !st.Watching {
		v.surface.Close()
		return
	}
	if frame := s.Session.Frame(st.Mid, st.Kind); frame != nil {
		v.surface.Update(frame)
	}
	scale := c.Paint.Zoom * c.Paint.DPI()
	s.Session.SetBox(st.Mid, st.Kind, int(r.W*scale), int(r.H*scale))
}

func (s *Screen) togglePreview(st app.Stream) {
	if st.Watching {
		go s.Session.Unwatch(st.Mid, st.Kind)
	} else {
		go s.Session.Watch(st.Mid, st.Kind)
	}
	if st.Kind == kindCamera {
		s.Settings.CameraPreview = !st.Watching
		s.Settings.Save()
	}
}

func memberOf(roster []hclient.Member, mid int) hclient.Member {
	for _, member := range roster {
		if member.Mid == mid {
			return member
		}
	}
	return hclient.Member{}
}
