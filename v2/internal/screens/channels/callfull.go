package channels

import (
	"time"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

// drawFull puts one stream over the whole window; the caption and buttons show while the pointer is moving.
func (s *Screen) drawFull(c *widget.Context, m model) {
	window := geom.Rect{W: c.Viewport.W, H: c.Viewport.H}
	c.Popup(window)
	c.Overlay(func() { s.paintFull(c, m, window) })
}

func (s *Screen) paintFull(c *widget.Context, m model, window geom.Rect) {
	cs := &s.call
	if c.EscapeBase() {
		cs.endFull()
		redraw.Request()
		return
	}
	if c.In.Moved || c.In.Pressed {
		cs.lastMove = time.Now()
	}
	idle := time.Since(cs.lastMove)
	hud := idle < hudHold
	if hud {
		redraw.After(hudHold - idle)
	}
	for _, st := range cs.order {
		if keyOf(st) != cs.full {
			continue
		}
		v := cs.views[cs.full]
		s.feed(c, st, v, window)
		member := memberOf(m.roster, st.Mid)
		tile := widget.VideoTile{
			Surface: &v.surface, Name: v.label, Face: st.Nick, Error: st.Err,
			Own: st.Own, Mirror: st.Own && st.Kind == kindCamera, Preview: st.Watching,
			Speaking: s.speaking(m, member), Muted: member.Muted, ForceMuted: member.ForceMuted, Deafened: member.Deafened,
			Controls: hud, HideCaption: !hud, Flat: true,
		}
		s.tileSound(&tile, st, v)
		switch tile.Show(c, window) {
		case widget.TileMute:
			s.toggleStreamMute(st)
		case widget.TileMonitor:
			s.toggleShareMonitor()
		case widget.TileFullscreen:
			cs.endFull()
		case widget.TileClose:
			go s.Session.Unwatch(st.Mid, st.Kind)
			cs.endFull()
		case widget.TilePreview:
			s.togglePreview(st)
		}
	}
}
