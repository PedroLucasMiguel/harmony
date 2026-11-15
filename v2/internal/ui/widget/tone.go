package widget

import (
	"image/color"

	"harmony/v2/internal/ui/theme"
)

type Tone int

const (
	ToneText Tone = iota
	ToneMuted
	ToneAccent
	ToneDanger
	ToneOnAccent
	ToneWarn
	ToneDangerSoft
)

func (t Tone) Color(p theme.Palette) color.RGBA {
	switch t {
	case ToneMuted:
		return p.Muted
	case ToneAccent:
		return p.Accent
	case ToneDanger:
		return p.Danger
	case ToneDangerSoft:
		return p.DangerSoft
	case ToneWarn:
		return p.Warn
	case ToneOnAccent:
		return color.RGBA{255, 255, 255, 255}
	}
	return p.Text
}
