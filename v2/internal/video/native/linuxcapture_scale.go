package native

// Scaling of 8-bit pictures with integer weights: a box filter when the picture shrinks, bilinear when it grows. A plane of
// ch bytes a pixel (1 for luma, 2 for interleaved chroma, 4 for BGRA) is scaled one destination row at a time: the source
// rows that row needs are first scaled across and kept in a small ring, so memory does not grow with the source's height.

// axisWeights are the taps of every destination index on one axis, in Q16 and adding up to 65536.
type axisWeights struct {
	first, count, off []int32
	w                 []int32
	maxCount          int
}

func newAxisWeights(src, dst int) axisWeights {
	a := axisWeights{first: make([]int32, dst), count: make([]int32, dst), off: make([]int32, dst)}
	for i := range dst {
		a.off[i] = int32(len(a.w))
		if src >= dst {
			lo, hi := i*src, (i+1)*src
			j0, j1 := lo/dst, (hi-1)/dst
			a.first[i], a.count[i] = int32(j0), int32(j1-j0+1)
			var sum int32
			for j := j0; j <= j1; j++ {
				overlap := min(hi, (j+1)*dst) - max(lo, j*dst)
				w := int32(int64(overlap) * 65536 / int64(src))
				a.w = append(a.w, w)
				sum += w
			}
			a.w[len(a.w)-1-int(j1-j0)/2] += 65536 - sum
		} else {
			// Pixel centres: source position of the destination pixel's centre, in 1/(2*dst) units.
			pos := (2*i+1)*src - dst
			j0 := floorDiv(pos, 2*dst)
			frac := int32(int64(pos-j0*2*dst) * 65536 / int64(2*dst))
			j1 := j0 + 1
			w0, w1 := 65536-frac, frac
			j0, j1 = min(max(j0, 0), src-1), min(max(j1, 0), src-1)
			if j0 == j1 {
				a.first[i], a.count[i] = int32(j0), 1
				a.w = append(a.w, 65536)
			} else {
				a.first[i], a.count[i] = int32(j0), 2
				a.w = append(a.w, w0, w1)
			}
		}
		a.maxCount = max(a.maxCount, int(a.count[i]))
	}
	return a
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b < 0 {
		q--
	}
	return q
}

type capScaler struct {
	sw, sh, dw, dh, ch int
	hx, vy             axisWeights
	ring               []byte
	tag                []int32
	slots              int
}

func newCapScaler(sw, sh, dw, dh, ch int) *capScaler {
	s := &capScaler{sw: sw, sh: sh, dw: dw, dh: dh, ch: ch}
	if sw != dw || sh != dh {
		s.hx, s.vy = newAxisWeights(sw, dw), newAxisWeights(sh, dh)
		s.slots = s.vy.maxCount + 1
		s.ring = make([]byte, s.slots*dw*ch)
		s.tag = make([]int32, s.slots)
	}
	return s
}

// scale fills dst (dh rows of dw pixels, dstStride bytes apart) from src (sh rows, srcStride bytes apart).
func (s *capScaler) scale(dst []byte, dstStride int, src []byte, srcStride int) {
	rowBytes := s.dw * s.ch
	if s.sw == s.dw && s.sh == s.dh {
		for y := range s.dh {
			copy(dst[y*dstStride:][:rowBytes], src[y*srcStride:])
		}
		return
	}
	for i := range s.tag {
		s.tag[i] = -1
	}
	for y := range s.dh {
		first, count, off := int(s.vy.first[y]), int(s.vy.count[y]), int(s.vy.off[y])
		out := dst[y*dstStride:][:rowBytes]
		for t := range count {
			r := first + t
			slot := r % s.slots
			if s.tag[slot] != int32(r) {
				s.across(s.ring[slot*rowBytes:][:rowBytes], src[r*srcStride:][:s.sw*s.ch])
				s.tag[slot] = int32(r)
			}
		}
		w := s.vy.w[off : off+count]
		row := func(t int) []byte { return s.ring[((first+t)%s.slots)*rowBytes:][:rowBytes] }
		switch count {
		case 1:
			copy(out, row(0))
		case 2:
			a, b, wa, wb := row(0), row(1), w[0], w[1]
			for i := range out {
				out[i] = byte((int32(a[i])*wa + int32(b[i])*wb + 32768) >> 16)
			}
		default:
			for i := range out {
				var sum int32
				for t := range count {
					sum += int32(row(t)[i]) * w[t]
				}
				out[i] = byte((sum + 32768) >> 16)
			}
		}
	}
}

// across scales one source row to the destination's width.
func (s *capScaler) across(dst, src []byte) {
	hx := &s.hx
	switch s.ch {
	case 1:
		for x := range s.dw {
			f, n, o := int(hx.first[x]), int(hx.count[x]), int(hx.off[x])
			var sum int32
			for t := range n {
				sum += int32(src[f+t]) * hx.w[o+t]
			}
			dst[x] = byte((sum + 32768) >> 16)
		}
	case 2:
		for x := range s.dw {
			f, n, o := int(hx.first[x])*2, int(hx.count[x]), int(hx.off[x])
			var s0, s1 int32
			for t := range n {
				w := hx.w[o+t]
				s0 += int32(src[f+2*t]) * w
				s1 += int32(src[f+2*t+1]) * w
			}
			dst[2*x], dst[2*x+1] = byte((s0+32768)>>16), byte((s1+32768)>>16)
		}
	default:
		for x := range s.dw {
			f, n, o := int(hx.first[x])*4, int(hx.count[x]), int(hx.off[x])
			var s0, s1, s2, s3 int32
			for t := range n {
				w := hx.w[o+t]
				p := src[f+4*t:][:4]
				s0 += int32(p[0]) * w
				s1 += int32(p[1]) * w
				s2 += int32(p[2]) * w
				s3 += int32(p[3]) * w
			}
			d := dst[4*x:][:4]
			d[0], d[1], d[2], d[3] = byte((s0+32768)>>16), byte((s1+32768)>>16), byte((s2+32768)>>16), byte((s3+32768)>>16)
		}
	}
}
