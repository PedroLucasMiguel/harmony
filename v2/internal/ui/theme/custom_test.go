package theme

import (
	"image/color"
	"testing"
)

// The expected values are what the Electron client's customPalette writes for the same four colours.
func TestCustomDerivesTheOtherTokens(t *testing.T) {
	p := Custom(Colours{Bg: "#0f1116", Surface: "#171a21", Text: "#e6e8ee", Accent: "#5b8cff"})
	want := map[string]struct{ got, want color.RGBA }{
		"surface2":     {p.Surface2, color.RGBA{35, 38, 45, 255}},
		"border":       {p.Border, color.RGBA{50, 53, 60, 255}},
		"borderStrong": {p.BorderStrong, color.RGBA{73, 75, 82, 255}},
		"muted":        {p.Muted, color.RGBA{144, 146, 152, 255}},
		"accentHover":  {p.AccentHover, color.RGBA{114, 156, 255, 255}},
		"video":        {p.VideoBg, color.RGBA{8, 9, 11, 255}},
		"tint":         {p.Tint, color.RGBA{255, 255, 255, 255}},
	}
	for name, c := range want {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", name, c.got, c.want)
		}
	}
}

func TestCustomLightUsesTheDaylightStatusColours(t *testing.T) {
	p := Custom(Colours{Bg: "#f2f3f5", Surface: "#ffffff", Text: "#22262b", Accent: "#3a6df0"})
	day := palettes["daylight"]
	if p.Danger != day.Danger || p.Tint != (color.RGBA{0, 0, 0, 255}) {
		t.Errorf("light custom palette: danger %v tint %v", p.Danger, p.Tint)
	}
}

func TestHexRoundTrip(t *testing.T) {
	if got := Hex(parse("#5B8cff")); got != "#5b8cff" {
		t.Errorf("round trip = %q", got)
	}
}
