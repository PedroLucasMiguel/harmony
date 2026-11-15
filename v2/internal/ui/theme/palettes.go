// Package theme holds the colour palettes copied from the Electron client's stylesheet.
package theme

import "image/color"

// Palette is the colour set every component draws from; one per theme of the Electron client.
type Palette struct {
	Name         string
	Bg           color.RGBA
	Surface      color.RGBA
	Surface2     color.RGBA
	Border       color.RGBA
	BorderStrong color.RGBA
	Text         color.RGBA
	Muted        color.RGBA
	Accent       color.RGBA
	AccentHover  color.RGBA
	Danger       color.RGBA
	DangerSoft   color.RGBA
	Live         color.RGBA
	Warn         color.RGBA
	VideoBg      color.RGBA
	Tint         color.RGBA
	Radius       float32
}

var palettes = map[string]Palette{
	"midnight": {
		Name:         "midnight",
		Bg:           color.RGBA{15, 17, 22, 255},
		Surface:      color.RGBA{23, 26, 33, 255},
		Surface2:     color.RGBA{31, 35, 44, 255},
		Border:       color.RGBA{42, 47, 58, 255},
		BorderStrong: color.RGBA{59, 66, 82, 255},
		Text:         color.RGBA{230, 232, 238, 255},
		Muted:        color.RGBA{139, 147, 167, 255},
		Accent:       color.RGBA{91, 140, 255, 255},
		AccentHover:  color.RGBA{111, 155, 255, 255},
		Danger:       color.RGBA{224, 85, 97, 255},
		DangerSoft:   color.RGBA{255, 140, 140, 255},
		Live:         color.RGBA{63, 208, 127, 255},
		Warn:         color.RGBA{227, 160, 8, 255},
		VideoBg:      color.RGBA{7, 9, 13, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       10,
	},
	"dark": {
		Name:         "dark",
		Bg:           color.RGBA{30, 31, 34, 255},
		Surface:      color.RGBA{43, 45, 49, 255},
		Surface2:     color.RGBA{49, 51, 56, 255},
		Border:       color.RGBA{63, 65, 71, 255},
		BorderStrong: color.RGBA{78, 80, 88, 255},
		Text:         color.RGBA{219, 222, 225, 255},
		Muted:        color.RGBA{148, 155, 164, 255},
		Accent:       color.RGBA{88, 101, 242, 255},
		AccentHover:  color.RGBA{71, 82, 196, 255},
		Danger:       color.RGBA{218, 55, 60, 255},
		DangerSoft:   color.RGBA{249, 134, 138, 255},
		Live:         color.RGBA{35, 165, 90, 255},
		Warn:         color.RGBA{240, 177, 50, 255},
		VideoBg:      color.RGBA{0, 0, 0, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       8,
	},
	"onyx": {
		Name:         "onyx",
		Bg:           color.RGBA{0, 0, 0, 255},
		Surface:      color.RGBA{11, 11, 13, 255},
		Surface2:     color.RGBA{20, 20, 24, 255},
		Border:       color.RGBA{38, 38, 44, 255},
		BorderStrong: color.RGBA{58, 58, 66, 255},
		Text:         color.RGBA{232, 232, 234, 255},
		Muted:        color.RGBA{138, 138, 147, 255},
		Accent:       color.RGBA{124, 108, 255, 255},
		AccentHover:  color.RGBA{143, 130, 255, 255},
		Danger:       color.RGBA{224, 85, 97, 255},
		DangerSoft:   color.RGBA{255, 140, 140, 255},
		Live:         color.RGBA{63, 208, 127, 255},
		Warn:         color.RGBA{227, 160, 8, 255},
		VideoBg:      color.RGBA{0, 0, 0, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       10,
	},
	"forest": {
		Name:         "forest",
		Bg:           color.RGBA{14, 21, 18, 255},
		Surface:      color.RGBA{21, 32, 27, 255},
		Surface2:     color.RGBA{28, 42, 35, 255},
		Border:       color.RGBA{39, 58, 48, 255},
		BorderStrong: color.RGBA{53, 80, 63, 255},
		Text:         color.RGBA{227, 236, 230, 255},
		Muted:        color.RGBA{134, 162, 149, 255},
		Accent:       color.RGBA{63, 185, 132, 255},
		AccentHover:  color.RGBA{79, 209, 152, 255},
		Danger:       color.RGBA{224, 85, 97, 255},
		DangerSoft:   color.RGBA{255, 140, 140, 255},
		Live:         color.RGBA{110, 231, 168, 255},
		Warn:         color.RGBA{227, 160, 8, 255},
		VideoBg:      color.RGBA{5, 10, 8, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       10,
	},
	"ember": {
		Name:         "ember",
		Bg:           color.RGBA{23, 16, 14, 255},
		Surface:      color.RGBA{33, 23, 20, 255},
		Surface2:     color.RGBA{44, 31, 26, 255},
		Border:       color.RGBA{61, 42, 35, 255},
		BorderStrong: color.RGBA{85, 58, 48, 255},
		Text:         color.RGBA{240, 229, 224, 255},
		Muted:        color.RGBA{168, 144, 134, 255},
		Accent:       color.RGBA{255, 122, 77, 255},
		AccentHover:  color.RGBA{255, 145, 105, 255},
		Danger:       color.RGBA{224, 85, 97, 255},
		DangerSoft:   color.RGBA{255, 155, 155, 255},
		Live:         color.RGBA{79, 209, 152, 255},
		Warn:         color.RGBA{240, 177, 50, 255},
		VideoBg:      color.RGBA{11, 6, 5, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       10,
	},
	"lavender": {
		Name:         "lavender",
		Bg:           color.RGBA{20, 17, 29, 255},
		Surface:      color.RGBA{28, 24, 41, 255},
		Surface2:     color.RGBA{37, 32, 54, 255},
		Border:       color.RGBA{52, 44, 74, 255},
		BorderStrong: color.RGBA{73, 62, 102, 255},
		Text:         color.RGBA{233, 228, 245, 255},
		Muted:        color.RGBA{153, 143, 181, 255},
		Accent:       color.RGBA{167, 139, 250, 255},
		AccentHover:  color.RGBA{188, 164, 255, 255},
		Danger:       color.RGBA{224, 85, 97, 255},
		DangerSoft:   color.RGBA{255, 140, 140, 255},
		Live:         color.RGBA{95, 211, 166, 255},
		Warn:         color.RGBA{227, 160, 8, 255},
		VideoBg:      color.RGBA{10, 8, 16, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       12,
	},
	"ocean": {
		Name:         "ocean",
		Bg:           color.RGBA{11, 20, 28, 255},
		Surface:      color.RGBA{17, 30, 41, 255},
		Surface2:     color.RGBA{23, 40, 54, 255},
		Border:       color.RGBA{34, 57, 75, 255},
		BorderStrong: color.RGBA{47, 78, 103, 255},
		Text:         color.RGBA{223, 234, 242, 255},
		Muted:        color.RGBA{127, 153, 172, 255},
		Accent:       color.RGBA{56, 189, 248, 255},
		AccentHover:  color.RGBA{92, 205, 255, 255},
		Danger:       color.RGBA{224, 85, 97, 255},
		DangerSoft:   color.RGBA{255, 140, 140, 255},
		Live:         color.RGBA{63, 208, 127, 255},
		Warn:         color.RGBA{227, 160, 8, 255},
		VideoBg:      color.RGBA{4, 9, 13, 255},
		Tint:         color.RGBA{255, 255, 255, 255},
		Radius:       10,
	},
	"daylight": {
		Name:         "daylight",
		Bg:           color.RGBA{242, 243, 245, 255},
		Surface:      color.RGBA{255, 255, 255, 255},
		Surface2:     color.RGBA{235, 237, 239, 255},
		Border:       color.RGBA{212, 215, 220, 255},
		BorderStrong: color.RGBA{182, 187, 196, 255},
		Text:         color.RGBA{34, 38, 43, 255},
		Muted:        color.RGBA{92, 102, 112, 255},
		Accent:       color.RGBA{58, 109, 240, 255},
		AccentHover:  color.RGBA{42, 90, 214, 255},
		Danger:       color.RGBA{196, 48, 58, 255},
		DangerSoft:   color.RGBA{196, 48, 58, 255},
		Live:         color.RGBA{26, 149, 80, 255},
		Warn:         color.RGBA{154, 106, 0, 255},
		VideoBg:      color.RGBA{22, 24, 29, 255},
		Tint:         color.RGBA{0, 0, 0, 255},
		Radius:       10,
	},
}

// Names lists the themes in the order the settings offer them.
var Names = []string{"midnight", "dark", "onyx", "ocean", "forest", "ember", "lavender", "daylight"}
