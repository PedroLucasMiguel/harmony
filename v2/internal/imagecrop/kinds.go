package imagecrop

// Output is the size a picture is kept at and the most a server takes of it.
type Output struct {
	W, H     int
	MaxBytes int
	// PNG keeps what is cut out cut out, where the picture fits as one.
	PNG bool
}

// Kind is what can be edited, and how each is kept: the shape of the mask, its proportions, and the sizes it must come to.
type Kind struct {
	Circle bool
	// Aspect is the mask's width over its height.
	Aspect float64
	Still  Output
	// Gif is the size of an animated one, kept smaller and given more room because it is every frame; zero for a kind that is never animated.
	Gif Output
}

var (
	Avatar = Kind{Circle: true, Aspect: 1, Still: Output{W: 256, H: 256, MaxBytes: 256 << 10}, Gif: Output{W: 160, H: 160, MaxBytes: 1 << 20}}
	// Banner is about three times as wide as it is tall; the member list shows a strip of the middle.
	Banner = Kind{Aspect: 3, Still: Output{W: 960, H: 320, MaxBytes: 2 << 20}, Gif: Output{W: 720, H: 240, MaxBytes: 2 << 20}}
	// Logo is kept as a PNG so a logo that is a shape stays one; a photo too big for that falls back to a JPEG.
	Logo = Kind{Aspect: 1, Still: Output{W: 256, H: 256, MaxBytes: 256 << 10, PNG: true}}
	// Emoji is kept like a logo, at the size the picker draws it.
	Emoji = Kind{Aspect: 1, Still: Output{W: 128, H: 128, MaxBytes: 256 << 10, PNG: true}}
)
