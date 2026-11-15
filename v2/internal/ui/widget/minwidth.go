package widget

import "harmony/v2/internal/ui/geom"

// MinWidth keeps its child at least W wide, however little it needs.
type MinWidth struct {
	W     float32
	Child Component
}

func (m MinWidth) Measure(c *Context, maxWidth float32) geom.Size {
	s := m.Child.Measure(c, maxWidth)
	s.W = min(max(s.W, m.W), maxWidth)
	return s
}

func (m MinWidth) Draw(c *Context, r geom.Rect) { m.Child.Draw(c, r) }
