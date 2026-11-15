package video

import "harmony/v2/internal/video/native"

// Colour is how the picture's colours are coded: the H.273 code of the matrix that turns Y'CbCr into RGB (native.BT709,
// native.BT601 or 9 for BT.2020), and whether the values use the full range instead of the limited one.
type Colour struct {
	Matrix int
	Full   bool
}

// Picture is what a sequence parameter set says of the pictures.
type Picture struct {
	W, H int
	Colour
}

// widest640 is the widest picture Chromium still reads as BT.601 when a stream does not say; wider is BT.709.
const widest640 = 640

// coding reads an H.273 matrix code. A stream that does not say is read the way Chromium reads it, so that a picture
// looks here as it does in the Electron client: by its width, BT.709 for HD and BT.601 for SD.
func coding(matrix int, full bool, width int) Colour {
	switch matrix {
	case 1:
		return Colour{native.BT709, full}
	case 5, 6:
		return Colour{native.BT601, full}
	case 9, 10:
		return Colour{9, full}
	}
	if width > widest640 {
		return Colour{native.BT709, full}
	}
	return Colour{native.BT601, full}
}

// colour is how this capture's pictures are coded. Screens and test pictures are RGB and made BT.709; a camera hands
// over Y'CbCr that is kept as it is, BT.709 when it is HD and BT.601 when not.
func (o CaptureOptions) colour() Colour {
	if o.Source == "camera" && o.Height < 720 {
		return Colour{Matrix: native.BT601}
	}
	return Colour{Matrix: native.BT709}
}
