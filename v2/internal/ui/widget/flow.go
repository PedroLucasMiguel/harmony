package widget

import "harmony/v2/internal/ui/geom"

// Flow lays its items out in a line and goes on to the next line when one does not fit, each at its natural size.
type Flow struct {
	Gap, RowGap float32
	Items       []Component
}

// place walks the items, calling put with each one's rect, and returns the height used.
func (f *Flow) place(c *Context, r geom.Rect, put func(Component, geom.Rect)) float32 {
	x, y, line := float32(0), float32(0), float32(0)
	for _, item := range f.Items {
		size := item.Measure(c, r.W)
		if x > 0 && x+size.W > r.W {
			x, y, line = 0, y+line+f.RowGap, 0
		}
		if put != nil {
			put(item, geom.Rect{X: r.X + x, Y: r.Y + y, W: min(size.W, r.W), H: size.H})
		}
		x += size.W + f.Gap
		line = max(line, size.H)
	}
	return y + line
}

func (f *Flow) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: f.place(c, geom.Rect{W: maxWidth}, nil)}
}

func (f *Flow) Draw(c *Context, r geom.Rect) {
	f.place(c, r, func(item Component, at geom.Rect) { item.Draw(c, at) })
}
