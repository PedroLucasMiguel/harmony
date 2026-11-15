package channels

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

// column is one of the four that can be dragged wider or narrower; 0 is the channel list.
type column int

const (
	colSide column = iota
	colMembers
	colForum
	colDMs
)

// span is what Electron's COLUMNS table says of a column: the narrowest and widest a drag can make it, the narrowest a
// squeezed window can leave it, its usual width, and the most of the space it may take, in percent.
type span struct{ min, floor, normal, max, share float32 }

var spans = [...]span{
	colSide:    {160, 200, 260, 560, 38},
	colMembers: {120, 150, 200, 480, 34},
	colForum:   {200, 200, 352, 640, 55},
	colDMs:     {220, 220, 320, 640, 45},
}

const (
	handleWidth   = 9
	handleBar     = 3
	handleBarLeft = 3
	handleBarR    = 2
	handleInside  = 8
)

type resizing struct {
	column  column
	active  bool
	startX  float32
	startW  float32
	changed bool
}

func (s *Screen) widthSetting(k column) *int {
	switch k {
	case colSide:
		return &s.Settings.SideWidth
	case colMembers:
		return &s.Settings.MembersWidth
	case colForum:
		return &s.Settings.ForumListWidth
	}
	return &s.Settings.DMListWidth
}

func (s *Screen) textScale() float32 {
	if s.Settings.TextScale <= 0 {
		return 1
	}
	return float32(s.Settings.TextScale) / 100
}

// columnWidth is the width a column wants in a space (the window, or the panel the column is in) and the least a squeezed layout may give it.
func (s *Screen) columnWidth(k column, space float32) (want, least float32) {
	sp := spans[k]
	w := float32(*s.widthSetting(k))
	if w == 0 {
		ts := s.textScale()
		return sp.normal * ts, sp.floor * ts
	}
	w = min(max(w, sp.min), sp.max)
	return min(w, sp.share/100*space), min(sp.floor, w)
}

// dragHandle is the strip beside a column's edge: the pointer turns to a resize arrow over it, a drag sets the width live and a double press puts the usual one back. barX is where the accent line shows, growing is +1 when moving right widens the column and -1 when it narrows it.
func (s *Screen) dragHandle(c *widget.Context, k column, area geom.Rect, barX, growing, current, space float32) {
	r := &s.resize
	mine := r.active && r.column == k
	hot := c.Hovered(area) && (!r.active || mine)
	if hot || mine {
		c.SetCursor(rl.MouseCursorResizeEW)
	}
	if hot && c.In.Pressed {
		c.Claim()
		if c.In.Clicks == 2 {
			*s.widthSetting(k) = 0
			s.Settings.Save()
			return
		}
		*r = resizing{column: k, active: true, startX: c.In.MouseX, startW: current}
		mine = true
	}
	if mine {
		if !c.In.Down {
			r.active = false
			s.Settings.Save()
		} else {
			*s.widthSetting(k) = dragged(k, r.startW+growing*(c.In.MouseX-r.startX), space)
		}
	}
	if hot || mine {
		c.Paint.Fill(geom.Rect{X: barX, Y: area.Y, W: handleBar, H: area.H}, handleBarR, c.Theme.Accent)
	}
}

// dragged is the setting a dragged width comes to: kept within what the column allows, which includes its share of the space so the column follows the pointer to the end and no further, and 0 (the usual width) when it is within two of it.
func dragged(k column, w, space float32) int {
	sp := spans[k]
	w = min(max(w, sp.min), min(sp.max, sp.share/100*space))
	if w-sp.normal < 2 && sp.normal-w < 2 {
		return 0
	}
	return int(w + 0.5)
}

func (s *Screen) sideHandle(c *widget.Context, side geom.Rect, space float32) {
	area := geom.Rect{X: side.Right() - handleInside, Y: side.Y, W: handleInside + columnGap, H: side.H}
	s.dragHandle(c, colSide, area, side.Right()-handleBarLeft+2, 1, side.W, space)
}

func (s *Screen) membersHandle(c *widget.Context, members geom.Rect, space float32) {
	area := geom.Rect{X: members.X - columnGap, Y: members.Y, W: columnGap + handleInside, H: members.H}
	s.dragHandle(c, colMembers, area, members.X-handleBarLeft+1, -1, members.W, space)
}

func (s *Screen) drawColumnHandles(c *widget.Context, l layout) {
	if s.dm.page {
		return
	}
	s.sideHandle(c, l.side, l.bounds.W)
	if l.members.W > 0 {
		s.membersHandle(c, l.members, l.bounds.W)
	}
}
