package theme

import "image/color"

const Default = "midnight"

// The presence colours are the same in every palette.
var (
	StatusOnline       = color.RGBA{59, 165, 93, 255}
	StatusIdle         = color.RGBA{240, 178, 50, 255}
	StatusDoNotDisturb = color.RGBA{242, 63, 67, 255}
)

func ByName(name string) Palette {
	if p, ok := palettes[name]; ok {
		return p
	}
	return palettes[Default]
}

func WithAlpha(c color.RGBA, alpha float32) color.RGBA {
	return color.RGBA{R: c.R, G: c.G, B: c.B, A: uint8(alpha*255 + 0.5)}
}

func Brighten(c color.RGBA, factor float32) color.RGBA {
	scale := func(v uint8) uint8 { return uint8(min(255, float32(v)*factor+0.5)) }
	return color.RGBA{R: scale(c.R), G: scale(c.G), B: scale(c.B), A: c.A}
}

func Mix(a, b color.RGBA, t float32) color.RGBA {
	lerp := func(x, y uint8) uint8 { return uint8(float32(x) + (float32(y)-float32(x))*t + 0.5) }
	return color.RGBA{R: lerp(a.R, b.R), G: lerp(a.G, b.G), B: lerp(a.B, b.B), A: lerp(a.A, b.A)}
}
