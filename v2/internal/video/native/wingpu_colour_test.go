package native

import "testing"

// D3D11_VIDEO_PROCESSOR_COLOR_SPACE is Usage:1, RGB_Range:1, YCbCr_Matrix:1, YCbCr_xvYCC:1, Nominal_Range:2 from the
// lowest bit up; a wrong position gives a picture of the wrong colours that no error reports.
func TestInputColorSpaceBits(t *testing.T) {
	cases := []struct {
		matrix int
		full   bool
		want   vpColorSpace
	}{
		{BT601, false, 1 << 4},
		{BT709, false, 1<<4 | 1<<2},
		{BT601, true, 2 << 4},
		{BT709, true, 2<<4 | 1<<2},
	}
	for _, c := range cases {
		if got := inputColorSpace(c.matrix, c.full); got != c.want {
			t.Errorf("matrix %d full %v: %#x, want %#x", c.matrix, c.full, got, c.want)
		}
	}
	if outputColorSpace != 0 {
		t.Error("the picture is made in the full RGB range")
	}
}

func TestSwapRB(t *testing.T) {
	dst := make([]byte, 8)
	swapRB(dst, []byte{1, 2, 3, 4, 5, 6, 7, 8})
	if want := []byte{3, 2, 1, 4, 7, 6, 5, 8}; string(dst) != string(want) {
		t.Errorf("got %v, want %v", dst, want)
	}
}
