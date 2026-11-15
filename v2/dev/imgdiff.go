//go:build ignore

// imgdiff compares two screenshots: imgdiff a.png b.png [x y w h scale out.png]
// Prints the share of differing pixels and, with a crop, writes a side by side enlargement (a | b | difference).
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"strconv"
)

func load(path string) image.Image {
	f, err := os.Open(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		panic(err)
	}
	return img
}

func channel(c color.Color) (r, g, b int) {
	cr, cg, cb, _ := c.RGBA()
	return int(cr >> 8), int(cg >> 8), int(cb >> 8)
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func atoi(s string) int {
	v, _ := strconv.Atoi(s)
	return v
}

func main() {
	a, b := load(os.Args[1]), load(os.Args[2])
	bounds := a.Bounds().Intersect(b.Bounds())
	if len(os.Args) > 3 && (os.Args[3] == "align" || os.Args[3] == "px") {
		bounds = a.Bounds()
	}
	different, total := 0, 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			ar, ag, ab := channel(a.At(x, y))
			br, bg, bb := channel(b.At(x, y))
			total++
			if abs(ar-br)+abs(ag-bg)+abs(ab-bb) > 24 {
				different++
			}
		}
	}
	fmt.Printf("%.2f%% of pixels differ (%d of %d)\n", 100*float64(different)/float64(total), different, total)
	if len(os.Args) > 3 && os.Args[3] == "align" {
		x0, y0, w, h := atoi(os.Args[4]), atoi(os.Args[5]), atoi(os.Args[6]), atoi(os.Args[7])
		bestDx, bestDy, best := 0, 0, int(^uint(0)>>1)
		for dy := -12; dy <= 12; dy++ {
			for dx := -12; dx <= 12; dx++ {
				cost := 0
				for y := 0; y < h; y += 1 {
					for x := 0; x < w; x += 1 {
						ar, ag, ab := channel(a.At(x0+x, y0+y))
						br, bg, bb := channel(b.At(x0+x+dx, y0+y+dy))
						cost += abs(ar-br) + abs(ag-bg) + abs(ab-bb)
					}
				}
				if cost < best {
					best, bestDx, bestDy = cost, dx, dy
				}
			}
		}
		fmt.Printf("electron is shifted by dx=%d dy=%d device px from v2 (cost %d)\n", bestDx, bestDy, best)
		return
	}
	if len(os.Args) > 3 && os.Args[3] == "px" {
		x, y := atoi(os.Args[4]), atoi(os.Args[5])
		ar, ag, ab := channel(a.At(x, y))
		br, bg, bb := channel(b.At(x, y))
		fmt.Printf("v2 rgb(%d,%d,%d)  electron rgb(%d,%d,%d)\n", ar, ag, ab, br, bg, bb)
		return
	}
	if len(os.Args) < 9 {
		return
	}
	n := func(i int) int { v, _ := strconv.Atoi(os.Args[i]); return v }
	x0, y0, w, h, scale := n(3), n(4), n(5), n(6), n(7)
	out := image.NewRGBA(image.Rect(0, 0, 3*w*scale+8, h*scale))
	for y := 0; y < h*scale; y++ {
		for x := 0; x < w*scale; x++ {
			sx, sy := x0+x/scale, y0+y/scale
			ac, bc := a.At(sx, sy), b.At(sx, sy)
			ar, ag, ab := channel(ac)
			br, bg, bb := channel(bc)
			out.Set(x, y, ac)
			out.Set(x+w*scale+4, y, bc)
			out.Set(x+2*w*scale+8, y, color.RGBA{uint8(min(255, 4*abs(ar-br))), uint8(min(255, 4*abs(ag-bg))), uint8(min(255, 4*abs(ab-bb))), 255})
		}
	}
	f, _ := os.Create(os.Args[8])
	defer f.Close()
	_ = png.Encode(f, out)
}
