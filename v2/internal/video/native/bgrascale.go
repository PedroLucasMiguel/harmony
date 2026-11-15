package native

// Box filter scaling of BGRA pictures, and the size a capture is encoded at. The Windows capture uses them when the
// graphics hardware cannot scale (a camera picture, or a screen without a video processor).

// scaledSize is the size of a stream of height wantH made from a source of srcW by srcH: the shape of the source, even
// numbers, never larger than the source.
func scaledSize(srcW, srcH, wantH int) (w, h int) {
	h = wantH
	if h <= 0 || h > srcH {
		h = srcH
	}
	h &^= 1
	h = max(h, 2)
	w = (srcW*h + srcH/2) / srcH
	w &^= 1
	return max(w, 2), h
}

// bgraScaler averages the source pixels each destination pixel covers; the destination is never larger than the source.
type bgraScaler struct {
	sw, sh, dw, dh int
	xs             []int32  // dw+1 source column bounds
	acc            []uint32 // dw*4 sums of one destination row
}

func newBGRAScaler(sw, sh, dw, dh int) *bgraScaler {
	s := &bgraScaler{sw: sw, sh: sh, dw: dw, dh: dh, xs: make([]int32, dw+1), acc: make([]uint32, dw*4)}
	for x := 0; x <= dw; x++ {
		s.xs[x] = int32(x * sw / dw)
	}
	return s
}

// scale fills dst (dw*4 bytes a row, tightly packed) from src, whose rows are srcStride bytes apart; a negative srcStride
// says the rows are stored bottom first, as bgraToNV12 reads it.
func (s *bgraScaler) scale(dst, src []byte, srcStride int) {
	step, first := srcStride, 0
	if srcStride < 0 {
		first = (s.sh - 1) * -srcStride
	}
	for dy := 0; dy < s.dh; dy++ {
		y0, y1 := dy*s.sh/s.dh, (dy+1)*s.sh/s.dh
		if y1 == y0 {
			y1++
		}
		clear(s.acc)
		for sy := y0; sy < y1; sy++ {
			row := src[first+sy*step : first+sy*step+s.sw*4]
			for dx := 0; dx < s.dw; dx++ {
				a := s.acc[dx*4 : dx*4+4 : dx*4+4]
				for x := int(s.xs[dx]); x < int(s.xs[dx+1]); x++ {
					p := row[x*4 : x*4+4 : x*4+4]
					a[0] += uint32(p[0])
					a[1] += uint32(p[1])
					a[2] += uint32(p[2])
					a[3] += uint32(p[3])
				}
			}
		}
		out := dst[dy*s.dw*4 : (dy+1)*s.dw*4]
		for dx := 0; dx < s.dw; dx++ {
			n := uint32(int(s.xs[dx+1]-s.xs[dx]) * (y1 - y0))
			a := s.acc[dx*4 : dx*4+4 : dx*4+4]
			o := out[dx*4 : dx*4+4 : dx*4+4]
			o[0], o[1], o[2], o[3] = byte(a[0]/n), byte(a[1]/n), byte(a[2]/n), byte(a[3]/n)
		}
	}
}
