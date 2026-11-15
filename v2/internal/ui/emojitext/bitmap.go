package emojitext

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"

	xdraw "golang.org/x/image/draw"
)

// Bitmap is a colour glyph at its device size: straight (not premultiplied) alpha, placed by the offset of its top left corner from the pen on the baseline.
type Bitmap struct {
	Pix       []color.RGBA
	W, H      int
	Left, Top float32
}

// decode reads a PNG as premultiplied alpha, which is what resampling needs to keep the edges clean.
func decode(data []byte) (*image.RGBA, bool) {
	src, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	img := image.NewRGBA(src.Bounds())
	draw.Draw(img, img.Rect, src, src.Bounds().Min, draw.Src)
	return img, true
}

func resize(src *image.RGBA, w, h int) *image.RGBA {
	if src.Rect.Dx() == w && src.Rect.Dy() == h {
		return src
	}
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(out, out.Rect, src, src.Rect, xdraw.Src, nil)
	return out
}

func straight(img *image.RGBA) []color.RGBA {
	pix := make([]color.RGBA, img.Rect.Dx()*img.Rect.Dy())
	for i := range pix {
		p := img.Pix[4*i : 4*i+4]
		a := uint32(p[3])
		if a == 0 {
			continue
		}
		pix[i] = color.RGBA{R: unpremultiply(p[0], a), G: unpremultiply(p[1], a), B: unpremultiply(p[2], a), A: p[3]}
	}
	return pix
}

func unpremultiply(c uint8, a uint32) uint8 { return uint8(min(uint32(c)*255+a/2, 255*a) / a) }

func round(v float32) int { return int(math.Round(float64(v))) }
