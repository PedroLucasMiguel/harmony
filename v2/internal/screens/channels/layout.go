package channels

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const (
	stripHeight      = 58.5
	panelStripGap    = 19.7
	channelHeadH     = 30.8
	sidePaddingRight = 12.8
)

// layout is where each part of the screen goes for the current window.
type layout struct {
	bounds  geom.Rect
	bar     geom.Rect
	head    geom.Rect
	side    geom.Rect
	main    geom.Rect
	members geom.Rect
	strip   geom.Rect
	drawer  geom.Rect
	narrow  bool
	// banner is the hash of the server picture behind the head, which then reaches headBannerExtra further down; empty for none.
	banner string
}

func (s *Screen) layout(b geom.Rect) layout {
	l := layout{bounds: b, bar: geom.Rect{X: b.X, Y: b.Y, W: b.W, H: barHeight}}
	body := geom.Rect{X: b.X + layoutPadLeft, Y: b.Y + barHeight + layoutPadding, W: b.W - layoutPadLeft - layoutPadding, H: b.H - barHeight - 2*layoutPadding}

	showMembers := s.Settings.ShowMembers && b.W >= narrowWidth && s.forum.post == 0
	side, sideMin := s.columnWidth(colSide, b.W)
	members, membersMin := s.columnWidth(colMembers, b.W)
	free := body.W - side - columnGap
	if showMembers {
		free -= members + columnGap
	}
	if free < mainMinWidth {
		shrink := mainMinWidth - free
		cut := min(shrink, max(0, side-sideMin))
		side -= cut
		shrink -= cut
		if showMembers {
			members -= min(shrink, max(0, members-membersMin))
		}
	}
	l.side = geom.Rect{X: body.X, Y: body.Y, W: side, H: body.H}
	x := l.side.Right() + columnGap
	mainW := body.Right() - x
	if showMembers {
		l.members = geom.Rect{X: body.Right() - members, Y: body.Y, W: members, H: body.H}
		mainW = l.members.X - columnGap - x
	}
	l.main = geom.Rect{X: x, Y: body.Y, W: mainW, H: body.H}
	l.head = geom.Rect{X: b.X, Y: b.Y, W: l.side.Right() - b.X - 1, H: barHeight}
	s.reserveBanner(&l)
	l.strip = geom.Rect{X: b.X - widget.RailWidth, Y: b.Bottom() - stripHeight, W: l.side.Right() - (b.X - widget.RailWidth), H: stripHeight}
	s.narrowLayout(&l)
	return l
}
