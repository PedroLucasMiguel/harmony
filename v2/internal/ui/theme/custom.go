package theme

import (
	"image/color"
	"math"
	"strings"
)

const CustomName = "custom"

// Colours are the four a person picks for the custom palette, as "#rrggbb".
type Colours struct {
	Bg      string `json:"bg"`
	Surface string `json:"surface"`
	Text    string `json:"text"`
	Accent  string `json:"accent"`
}

// Colours is the four that make up a palette, so a custom palette can start from the one in use.
func (p Palette) Colours() Colours {
	return Colours{Bg: Hex(p.Bg), Surface: Hex(p.Surface), Text: Hex(p.Text), Accent: Hex(p.Accent)}
}

// Custom derives a whole palette from four colours the way the Electron client does: the other tokens are mixes of them.
func Custom(c Colours) Palette {
	bg, surface, text, accent := parse(c.Bg), parse(c.Surface), parse(c.Text), parse(c.Accent)
	light := luminance(bg) > 0.5
	p := palettes[Default]
	p.Name = CustomName
	p.Bg, p.Surface, p.Text, p.Accent = bg, surface, text, accent
	p.Surface2 = mixRGB(surface, text, 0.06)
	p.Border = mixRGB(surface, text, 0.13)
	p.BorderStrong = mixRGB(surface, text, 0.24)
	p.Muted = mixRGB(text, bg, 0.4)
	black, white := color.RGBA{0, 0, 0, 255}, color.RGBA{255, 255, 255, 255}
	if light {
		p.AccentHover = mixRGB(accent, black, 0.14)
		p.Tint = black
		p.VideoBg = mixRGB(bg, black, 0.88)
		day := palettes["daylight"]
		p.Danger, p.DangerSoft, p.Live, p.Warn = day.Danger, day.DangerSoft, day.Live, day.Warn
	} else {
		p.AccentHover = mixRGB(accent, white, 0.14)
		p.Tint = white
		p.VideoBg = mixRGB(bg, black, 0.5)
	}
	return p
}

// Hex is "#rrggbb".
func Hex(c color.RGBA) string {
	const digits = "0123456789abcdef"
	return string([]byte{'#', digits[c.R>>4], digits[c.R&15], digits[c.G>>4], digits[c.G&15], digits[c.B>>4], digits[c.B&15]})
}

// parse reads "#rrggbb" the way the Electron client does: a short or broken code is padded with zeros.
func parse(s string) color.RGBA {
	s = strings.TrimPrefix(s, "#")
	for len(s) < 6 {
		s += "0"
	}
	var n uint32
	for _, r := range s[:6] {
		n <<= 4
		switch {
		case r >= '0' && r <= '9':
			n |= uint32(r - '0')
		case r >= 'a' && r <= 'f':
			n |= uint32(r-'a') + 10
		case r >= 'A' && r <= 'F':
			n |= uint32(r-'A') + 10
		}
	}
	return color.RGBA{uint8(n >> 16), uint8(n >> 8), uint8(n), 255}
}

func luminance(c color.RGBA) float64 {
	return (0.2126*float64(c.R) + 0.7152*float64(c.G) + 0.0722*float64(c.B)) / 255
}

func mixRGB(a, b color.RGBA, t float64) color.RGBA {
	mix := func(x, y uint8) uint8 { return uint8(math.Floor(float64(x) + (float64(y)-float64(x))*t + 0.5)) }
	return color.RGBA{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B), 255}
}
