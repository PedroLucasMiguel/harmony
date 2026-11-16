package native

// The video processor's colour space word and the row copy of a picture it made in B, G, R, A order. Pure Go, so the test
// that pins the bit positions of the Windows header runs everywhere.

const (
	// vpRangeLimited and vpRangeFull are D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235 and _0_255.
	vpRangeLimited = 1
	vpRangeFull    = 2
)

// vpColorSpace is D3D11_VIDEO_PROCESSOR_COLOR_SPACE: Usage:1, RGB_Range:1, YCbCr_Matrix:1, YCbCr_xvYCC:1, Nominal_Range:2.
type vpColorSpace uint32

func inputColorSpace(matrix int, full bool) vpColorSpace {
	cs := vpColorSpace(vpRangeLimited << 4)
	if full {
		cs = vpRangeFull << 4
	}
	if matrix == BT709 {
		cs |= 1 << 2
	}
	return cs
}

// outputColorSpace says the RGB picture uses the full range, 0 to 255.
const outputColorSpace = vpColorSpace(0)

// swapRB copies a row of B, G, R, A pixels as R, G, B, A.
func swapRB(dst, src []byte) {
	for i := 0; i+3 < len(src); i += 4 {
		dst[i], dst[i+1], dst[i+2], dst[i+3] = src[i+2], src[i+1], src[i], src[i+3]
	}
}
