package widget

import "harmony/v2/internal/ui/geom"

type Column struct {
	Gap      float32
	Children []Component
}

func Col(gap float32, children ...Component) *Column { return &Column{Gap: gap, Children: children} }

func (col *Column) Measure(c *Context, maxWidth float32) geom.Size {
	height := float32(0)
	for i, child := range col.Children {
		if i > 0 {
			height += col.Gap
		}
		height += child.Measure(c, maxWidth).H
	}
	return geom.Size{W: maxWidth, H: height}
}

func (col *Column) Draw(c *Context, r geom.Rect) {
	y := r.Y
	for _, child := range col.Children {
		h := child.Measure(c, r.W).H
		child.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
		y += h + col.Gap
	}
}

type Align int

const (
	AlignCenter Align = iota
	AlignStart
)

type RowItem struct {
	Component
	Grow bool
	// Weight is the share of the spare width a growing item takes; zero counts as one.
	Weight float32
	Align  Align
}

type Row struct {
	Gap   float32
	Items []RowItem
}

func Fixed(c Component) RowItem { return RowItem{Component: c} }

func Grow(c Component) RowItem { return RowItem{Component: c, Grow: true} }

// GrowBy is Grow with a share of the spare width, as grid-template-columns: 1.4fr 1fr gives.
func GrowBy(weight float32, c Component) RowItem {
	return RowItem{Component: c, Grow: true, Weight: weight}
}

func (r RowItem) weight() float32 {
	if r.Weight > 0 {
		return r.Weight
	}
	return 1
}

// widths is each item's width; out is room for them that the caller owns, so a few items cost no allocation.
func (row *Row) widths(c *Context, maxWidth float32, out []float32) []float32 {
	widths := append(out, make([]float32, len(row.Items))...)
	used, growing := float32(0), float32(0)
	for i, item := range row.Items {
		if i > 0 {
			used += row.Gap
		}
		if item.Grow {
			growing += item.weight()
			continue
		}
		widths[i] = item.Measure(c, maxWidth).W
		used += widths[i]
	}
	for i, item := range row.Items {
		if item.Grow {
			widths[i] = max(0, (maxWidth-used)*item.weight()/growing)
		}
	}
	return widths
}

func (row *Row) Measure(c *Context, maxWidth float32) geom.Size {
	height, width := float32(0), float32(0)
	var room [8]float32
	for i, w := range row.widths(c, maxWidth, room[:0]) {
		height = max(height, row.Items[i].Measure(c, w).H)
		width += w
	}
	return geom.Size{W: width + row.Gap*float32(max(0, len(row.Items)-1)), H: height}
}

func (row *Row) Draw(c *Context, r geom.Rect) {
	x := r.X
	var room [8]float32
	for i, w := range row.widths(c, r.W, room[:0]) {
		item := row.Items[i]
		h := item.Measure(c, w).H
		y := r.Y + (r.H-h)/2
		if item.Align == AlignStart {
			y = r.Y
		}
		item.Draw(c, geom.Rect{X: x, Y: y, W: w, H: h})
		x += w + row.Gap
	}
}

type Spacer struct{ W, H float32 }

func (s Spacer) Measure(*Context, float32) geom.Size { return geom.Size{W: s.W, H: s.H} }

func (s Spacer) Draw(*Context, geom.Rect) {}

type Padded struct {
	Left, Top, Right, Bottom float32
	Child                    Component
}

func (p Padded) Measure(c *Context, maxWidth float32) geom.Size {
	inner := p.Child.Measure(c, maxWidth-p.Left-p.Right)
	return geom.Size{W: inner.W + p.Left + p.Right, H: inner.H + p.Top + p.Bottom}
}

func (p Padded) Draw(c *Context, r geom.Rect) {
	p.Child.Draw(c, r.Inset(p.Left, p.Top, p.Right, p.Bottom))
}

// Start keeps its child at its natural width, against the left edge, instead of stretching it.
type Start struct{ Child Component }

func (s Start) Measure(c *Context, maxWidth float32) geom.Size { return s.Child.Measure(c, maxWidth) }

func (s Start) Draw(c *Context, r geom.Rect) {
	size := s.Child.Measure(c, r.W)
	s.Child.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: min(size.W, r.W), H: r.H})
}
