package people

import "harmony/v2/internal/hclient"

// StyleFor is the style of a name from the parts of a look being edited.
func StyleFor(mode, color string, colors []string, speed float64) Style {
	return LookOf(&hclient.NameStyle{Mode: mode, Color: color, Colors: colors, Speed: speed})
}
