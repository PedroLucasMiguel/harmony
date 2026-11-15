package imagecrop

import (
	"image"
	"image/color"
	"image/draw"
	"math"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/math/f64"
)

// Behind a picture that does not reach all the way, the colour of the pages it is shown on.
var background = color.NRGBA{0x20, 0x22, 0x25, 255}

func rotation(deg float64) f64.Aff3 {
	c, s := math.Cos(rad(deg)), math.Sin(rad(deg))
	return f64.Aff3{c, -s, 0, s, c, 0}
}

func scaling(sx, sy float64) f64.Aff3 { return f64.Aff3{sx, 0, 0, 0, sy, 0} }

func translation(x, y float64) f64.Aff3 { return f64.Aff3{1, 0, x, 0, 1, y} }

// mul is the transform that does b first and a after.
func mul(a, b f64.Aff3) f64.Aff3 {
	return f64.Aff3{
		a[0]*b[0] + a[1]*b[3], a[0]*b[1] + a[1]*b[4], a[0]*b[2] + a[1]*b[5] + a[2],
		a[3]*b[0] + a[4]*b[3], a[3]*b[1] + a[4]*b[4], a[3]*b[2] + a[4]*b[5] + a[5],
	}
}

// Render draws what is under the mask into dst, which is the mask's proportions at any size; the colour of the page is behind
// it, or nothing when transparent is set.
func Render(dst *image.NRGBA, src image.Image, p Placement, m Mask, transparent bool) {
	if transparent {
		clear(dst.Pix)
	} else {
		draw.Draw(dst, dst.Bounds(), image.NewUniform(background), image.Point{}, draw.Src)
	}
	k := float64(dst.Rect.Dx()) / m.W
	b := src.Bounds()
	sx, sy := p.S*k, p.S*k
	for sx < 0.5 && b.Dx() >= 4 && b.Dy() >= 4 {
		half := image.NewNRGBA(image.Rect(0, 0, b.Dx()/2, b.Dy()/2))
		xdraw.BiLinear.Scale(half, half.Bounds(), src, b, draw.Src, nil)
		sx *= float64(b.Dx()) / float64(half.Rect.Dx())
		sy *= float64(b.Dy()) / float64(half.Rect.Dy())
		src, b = half, half.Bounds()
	}
	to := mul(scaling(k, k), mul(translation(-m.X, -m.Y), mul(translation(p.CX, p.CY), mul(rotation(p.Deg), mul(scaling(sx/k, sy/k), translation(-float64(b.Dx())/2, -float64(b.Dy())/2))))))
	xdraw.CatmullRom.Transform(dst, to, src, b, draw.Over, nil)
}
