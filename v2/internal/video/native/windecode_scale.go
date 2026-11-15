// Shrinking an NV12 picture before it is turned into RGBA: every picture of the output is the mean of a few samples of the
// box of the source it covers (at most three along each side), so a big stream shown small stays smooth and costs little.
// Pure Go, so it builds everywhere and its tests run anywhere.

package native

// winFit is the size a w by h picture is shown at inside a box: shrunk to fit it, never enlarged, even sizes.
func winFit(w, h, boxW, boxH int) (int, int) {
	if boxW <= 0 || boxH <= 0 || (w <= boxW && h <= boxH) {
		return w &^ 1, h &^ 1
	}
	ow, oh := boxW, h*boxW/w
	if oh > boxH {
		ow, oh = w*boxH/h, boxH
	}
	ow, oh = ow&^1, oh&^1
	return max(ow, 2), max(oh, 2)
}

// winScaler holds the tables of one source and output size.
type winScaler struct {
	x0, x1 []int32
	recip  [10]int32
}

func newWinScaler() *winScaler {
	s := &winScaler{}
	for n := 1; n < len(s.recip); n++ {
		s.recip[n] = int32((65536 + n/2) / n)
	}
	return s
}

// plane scales a plane of sw by sh elements, each of comps bytes (1 for luma, 2 for interleaved chroma), to dw by dh,
// into dst whose rows are dw*comps bytes.
func (s *winScaler) plane(dst []byte, dw, dh int, src []byte, srcStride, sw, sh, comps int) {
	if cap(s.x0) < dw {
		s.x0, s.x1 = make([]int32, dw), make([]int32, dw)
	}
	x0, x1 := s.x0[:dw], s.x1[:dw]
	for ox := range x0 {
		a := ox * sw / dw
		b := max((ox+1)*sw/dw, a+1)
		x0[ox], x1[ox] = int32(a), int32(b)
	}
	for oy := 0; oy < dh; oy++ {
		ya := oy * sh / dh
		yb := max((oy+1)*sh/dh, ya+1)
		ty := min(yb-ya, 3)
		out := dst[oy*dw*comps : (oy+1)*dw*comps]
		for ox := 0; ox < dw; ox++ {
			xa, xb := int(x0[ox]), int(x1[ox])
			tx := min(xb-xa, 3)
			rec := s.recip[tx*ty]
			for c := 0; c < comps; c++ {
				var sum int32
				for j := 0; j < ty; j++ {
					row := src[(ya+j*(yb-ya)/ty)*srcStride:]
					for i := 0; i < tx; i++ {
						sum += int32(row[(xa+i*(xb-xa)/tx)*comps+c])
					}
				}
				out[ox*comps+c] = byte((sum*rec + 1<<15) >> 16)
			}
		}
	}
}
