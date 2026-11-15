package widget

import "harmony/v2/internal/ui/geom"

const (
	pictureWide = 16
	pictureHigh = 9
)

// GridColumns is how many columns make the biggest 16:9 pictures when count of them share a box of w by h. A tall box
// takes one column of wide pictures where a wide box takes two side by side; ties go to the squarer grid.
func GridColumns(count int, w, h, gap float32) int {
	best, bestArea := 1, float32(-1)
	if w <= 0 || h <= 0 || count < 2 {
		return 1
	}
	for cols := 1; cols <= count; cols++ {
		rows := (count + cols - 1) / cols
		cellW := (w - gap*float32(cols-1)) / float32(cols)
		cellH := (h - gap*float32(rows-1)) / float32(rows)
		pictureW := min(cellW, cellH*pictureWide/pictureHigh)
		if area := pictureW * pictureW * pictureHigh / pictureWide; area > bestArea+1 {
			best, bestArea = cols, area
		}
	}
	return best
}

// GridCell is the rectangle of tile i of count in a box, laid out in GridColumns columns that share the box exactly.
func GridCell(i, count int, box geom.Rect, gap float32) geom.Rect {
	cols := GridColumns(count, box.W, box.H, gap)
	rows := (count + cols - 1) / cols
	w := (box.W - gap*float32(cols-1)) / float32(cols)
	h := (box.H - gap*float32(rows-1)) / float32(rows)
	return geom.Rect{X: box.X + float32(i%cols)*(w+gap), Y: box.Y + float32(i/cols)*(h+gap), W: w, H: h}
}
