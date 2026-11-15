package faces

import (
	"bytes"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const maxPixels = 48 << 20

// Render decodes data and cuts the middle of it, in the box's proportions, down to w by h pixels; a round one is a disc.
func Render(data []byte, w, h int, round bool) (*image.NRGBA, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width*cfg.Height > maxPixels || cfg.Width == 0 || cfg.Height == 0 {
		return nil, image.ErrFormat
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return Fit(src, w, h, round), nil
}

// Fit is the cover-cropped, scaled copy of src that Render makes.
func Fit(src image.Image, w, h int, round bool) *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	crop := coverRect(src.Bounds(), w, h)
	cur, curRect := src, crop
	for curRect.Dx() >= 2*w && curRect.Dy() >= 2*h {
		half := image.NewNRGBA(image.Rect(0, 0, curRect.Dx()/2, curRect.Dy()/2))
		xdraw.BiLinear.Scale(half, half.Bounds(), cur, curRect, draw.Src, nil)
		cur, curRect = half, half.Bounds()
	}
	xdraw.CatmullRom.Scale(out, out.Bounds(), cur, curRect, draw.Src, nil)
	if round {
		roundOff(out)
	}
	return out
}

func coverRect(b image.Rectangle, w, h int) image.Rectangle {
	bw, bh := b.Dx(), b.Dy()
	if bw*h > bh*w {
		cw := bh * w / h
		x := b.Min.X + (bw-cw)/2
		return image.Rect(x, b.Min.Y, x+cw, b.Max.Y)
	}
	ch := bw * h / w
	y := b.Min.Y + (bh-ch)/2
	return image.Rect(b.Min.X, y, b.Max.X, y+ch)
}

// roundOff fades everything outside the inscribed circle to nothing, with a one pixel antialiased edge.
func roundOff(img *image.NRGBA) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	cx, cy, r := float64(w)/2, float64(h)/2, math.Min(float64(w), float64(h))/2
	for y := 0; y < h; y++ {
		dy := float64(y) + 0.5 - cy
		for x := 0; x < w; x++ {
			dx := float64(x) + 0.5 - cx
			edge := r - math.Hypot(dx, dy) + 0.5
			if edge >= 1 {
				continue
			}
			i := img.PixOffset(x, y) + 3
			if edge <= 0 {
				img.Pix[i] = 0
				continue
			}
			img.Pix[i] = uint8(float64(img.Pix[i]) * edge)
		}
	}
}
