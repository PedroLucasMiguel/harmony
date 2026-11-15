// Package geom holds the rectangle maths the layout and the painter share.
package geom

type Size struct{ W, H float32 }

type Rect struct{ X, Y, W, H float32 }

func (r Rect) Right() float32  { return r.X + r.W }
func (r Rect) Bottom() float32 { return r.Y + r.H }

func (r Rect) Contains(x, y float32) bool {
	return x >= r.X && x < r.Right() && y >= r.Y && y < r.Bottom()
}

func (r Rect) Inset(left, top, right, bottom float32) Rect {
	return Rect{r.X + left, r.Y + top, r.W - left - right, r.H - top - bottom}
}

func (r Rect) InsetAll(d float32) Rect { return r.Inset(d, d, d, d) }

func (r Rect) Intersect(o Rect) Rect {
	x, y := max(r.X, o.X), max(r.Y, o.Y)
	right, bottom := min(r.Right(), o.Right()), min(r.Bottom(), o.Bottom())
	return Rect{x, y, max(0, right-x), max(0, bottom-y)}
}
