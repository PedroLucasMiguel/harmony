package widget

import "harmony/v2/internal/ui/geom"

// Grid lays equal cells in rows, as many to a row as fit at MinCell wide (and no more than there are cells), the cells growing to use the row.
type Grid struct {
	MinCell  float32
	Gap      float32
	Children []Component
}

func (g *Grid) columns(width float32) int {
	return max(1, min(int((width+g.Gap)/(g.MinCell+g.Gap)), len(g.Children)))
}

func (g *Grid) cell(width float32) float32 {
	n := float32(g.columns(width))
	return (width - (n-1)*g.Gap) / n
}

func (g *Grid) rowHeight(c *Context, row []Component, cell float32) float32 {
	height := float32(0)
	for _, child := range row {
		height = max(height, child.Measure(c, cell).H)
	}
	return height
}

func (g *Grid) Measure(c *Context, maxWidth float32) geom.Size {
	cols, cell := g.columns(maxWidth), g.cell(maxWidth)
	height := float32(0)
	for i := 0; i < len(g.Children); i += cols {
		if i > 0 {
			height += g.Gap
		}
		height += g.rowHeight(c, g.Children[i:min(i+cols, len(g.Children))], cell)
	}
	return geom.Size{W: maxWidth, H: height}
}

func (g *Grid) Draw(c *Context, r geom.Rect) {
	cols, cell := g.columns(r.W), g.cell(r.W)
	y := r.Y
	for i := 0; i < len(g.Children); i += cols {
		row := g.Children[i:min(i+cols, len(g.Children))]
		height := g.rowHeight(c, row, cell)
		for j, child := range row {
			child.Draw(c, geom.Rect{X: r.X + float32(j)*(cell+g.Gap), Y: y, W: cell, H: height})
		}
		y += height + g.Gap
	}
}
