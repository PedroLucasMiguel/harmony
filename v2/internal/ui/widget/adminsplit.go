package widget

import (
	"harmony/v2/internal/ui/geom"
)

const (
	splitGap       = 16
	splitColMin    = 224
	splitColMax    = 352
	splitColShare  = 0.38
	splitEditorMax = 736
	splitNarrow    = 640
	splitStack     = 224
	splitListMin   = 128
	splitColGap    = 8
)

// AdminSplit is a page of the Server dialog that lists things at the left and edits the selected one at the right: over the list
// whatever Above holds (a search box), under it Below (add buttons), the list taking the height that is left. Narrow, the editor goes
// under the list.
type AdminSplit struct {
	Above  []Component
	List   *AdminList
	Below  []Component
	Editor Component
	// Height is the height the split fills; nil, or zero, is as tall as its content.
	Height func(c *Context) float32
}

func (s *AdminSplit) columnWidth(width float32) float32 {
	return min(max(width*splitColShare, splitColMin), splitColMax)
}

// narrow follows the window, as the Electron client's media query does, not the room the page has.
func (s *AdminSplit) narrow(c *Context) bool { return c.Viewport.W <= splitNarrow }

// column is the height of everything in the list column but the list, with the gaps.
func (s *AdminSplit) column(c *Context, width float32) float32 {
	h := float32(0)
	for _, a := range s.Above {
		h += a.Measure(c, width).H + splitColGap
	}
	for _, b := range s.Below {
		h += b.Measure(c, width).H + splitColGap
	}
	return h
}

func (s *AdminSplit) Measure(c *Context, maxWidth float32) geom.Size {
	if h := s.fill(c); h > 0 {
		return geom.Size{W: maxWidth, H: h}
	}
	if s.narrow(c) {
		h := s.column(c, maxWidth) + min(s.List.natural(c, maxWidth), splitStack)
		if s.Editor != nil {
			h += splitGap + s.Editor.Measure(c, maxWidth).H
		}
		return geom.Size{W: maxWidth, H: h}
	}
	col := s.columnWidth(maxWidth)
	h := s.column(c, col) + s.List.natural(c, col)
	if s.Editor != nil {
		h = max(h, s.Editor.Measure(c, min(maxWidth-col-splitGap, splitEditorMax)).H)
	}
	return geom.Size{W: maxWidth, H: h}
}

func (s *AdminSplit) fill(c *Context) float32 {
	if s.Height == nil {
		return 0
	}
	return s.Height(c)
}

func (s *AdminSplit) Draw(c *Context, r geom.Rect) {
	if s.narrow(c) {
		s.drawStacked(c, r)
		return
	}
	col := s.columnWidth(r.W)
	s.drawColumn(c, geom.Rect{X: r.X, Y: r.Y, W: col, H: r.H})
	if s.Editor != nil {
		width := min(r.W-col-splitGap, splitEditorMax)
		h := min(s.Editor.Measure(c, width).H, r.H)
		s.Editor.Draw(c, geom.Rect{X: r.X + col + splitGap, Y: r.Y, W: width, H: h})
	}
}

// drawColumn draws Above, the list and Below in the list column.
func (s *AdminSplit) drawColumn(c *Context, r geom.Rect) {
	y := r.Y
	for _, a := range s.Above {
		h := a.Measure(c, r.W).H
		a.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h + splitColGap
	}
	below := float32(0)
	for _, b := range s.Below {
		below += b.Measure(c, r.W).H + splitColGap
	}
	list := max(r.Bottom()-y-below, splitListMin)
	if s.fill(c) == 0 || len(s.List.Rows) == 0 && s.List.Empty == "" {
		list = s.List.natural(c, r.W)
	}
	s.List.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: list})
	y += list
	if list > 0 {
		y += splitColGap
	}
	for _, b := range s.Below {
		h := b.Measure(c, r.W).H
		b.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h + splitColGap
	}
}

func (s *AdminSplit) drawStacked(c *Context, r geom.Rect) {
	y := r.Y
	for _, a := range s.Above {
		h := a.Measure(c, r.W).H
		a.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h + splitColGap
	}
	list := min(s.List.natural(c, r.W), splitStack)
	s.List.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: list})
	y += list + splitColGap
	for _, b := range s.Below {
		h := b.Measure(c, r.W).H
		b.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h + splitColGap
	}
	if s.Editor != nil {
		y += splitGap - splitColGap
		s.Editor.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: s.Editor.Measure(c, r.W).H})
	}
}
