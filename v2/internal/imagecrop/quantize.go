package imagecrop

import (
	"image/color"
	"sort"
)

// quantize chooses up to n colours for all the frames at once, by median cut over a sample of their pixels: one palette for
// the whole picture, because a palette per frame flickers.
func quantize(frames []cutFrame, n int) color.Palette {
	var sample [][3]uint8
	every := max(1, len(frames)/12)
	for i := 0; i < len(frames); i += every {
		pix := frames[i].pix.Pix
		for j := 0; j+3 < len(pix); j += 16 {
			sample = append(sample, [3]uint8{pix[j], pix[j+1], pix[j+2]})
		}
	}
	boxes := [][][3]uint8{sample}
	for len(boxes) < n {
		widest, axis, span := -1, 0, 0
		for i, box := range boxes {
			if len(box) < 2 {
				continue
			}
			if a, s := widestAxis(box); s > span {
				widest, axis, span = i, a, s
			}
		}
		if widest < 0 {
			break
		}
		box := boxes[widest]
		sort.Slice(box, func(i, j int) bool { return box[i][axis] < box[j][axis] })
		mid := len(box) / 2
		boxes[widest] = box[:mid]
		boxes = append(boxes, box[mid:])
	}
	palette := make(color.Palette, 0, len(boxes))
	for _, box := range boxes {
		if len(box) == 0 {
			continue
		}
		var r, g, b int
		for _, c := range box {
			r, g, b = r+int(c[0]), g+int(c[1]), b+int(c[2])
		}
		palette = append(palette, color.RGBA{uint8(r / len(box)), uint8(g / len(box)), uint8(b / len(box)), 255})
	}
	return palette
}

func widestAxis(box [][3]uint8) (axis, span int) {
	lo, hi := [3]uint8{255, 255, 255}, [3]uint8{}
	for _, c := range box {
		for a := range 3 {
			lo[a], hi[a] = min(lo[a], c[a]), max(hi[a], c[a])
		}
	}
	for a := range 3 {
		if s := int(hi[a]) - int(lo[a]); s > span {
			axis, span = a, s
		}
	}
	return axis, span
}

// lookup finds the nearest palette colour, remembered per 5-bit-per-channel cell.
type lookup struct {
	palette color.Palette
	cells   [1 << 15]uint8
	known   [1 << 15]bool
}

func newLookup(p color.Palette) *lookup { return &lookup{palette: p} }

func (l *lookup) index(r, g, b uint8) uint8 {
	cell := int(r>>3)<<10 | int(g>>3)<<5 | int(b>>3)
	if l.known[cell] {
		return l.cells[cell]
	}
	best, bestD := 0, 1<<30
	cr, cg, cb := int(r>>3<<3|4), int(g>>3<<3|4), int(b>>3<<3|4)
	for i, c := range l.palette {
		pr, pg, pb, _ := c.RGBA()
		dr, dg, db := cr-int(pr>>8), cg-int(pg>>8), cb-int(pb>>8)
		if d := dr*dr + dg*dg + db*db; d < bestD {
			best, bestD = i, d
		}
	}
	l.cells[cell], l.known[cell] = uint8(best), true
	return uint8(best)
}
