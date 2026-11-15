package native

// Cropping and shrinking a decoded NV12 picture to the size asked for, then converting it to RGBA. A picture that is not
// shrunk goes straight through nv12ToRGBA; a smaller one is first averaged in box steps into a small NV12 picture, so the
// colour conversion works on the pixels that are kept.

// vdFit is the size a w by h picture is shown at in a box: as large as the box lets it be, never larger than it is, even.
func vdFit(w, h, boxW, boxH int) (int, int) {
	if boxW <= 0 || boxH <= 0 || w <= boxW && h <= boxH {
		return w &^ 1, h &^ 1
	}
	dw, dh := boxW, h*boxW/w
	if dh > boxH {
		dw, dh = w*boxH/h, boxH
	}
	return max(dw&^1, 2), max(dh&^1, 2)
}

// vdScaler holds the buffers of the shrinking so that a picture costs no allocation.
type vdScaler struct {
	nv12   []byte
	starts []int
	ends   []int
}

// convert makes dst (dw*dh*4 bytes) from the sw by sh part of the picture that starts at sx, sy (all even).
func (s *vdScaler) convert(dst []byte, y []byte, yStride int, uv []byte, uvStride int, sx, sy, sw, sh, dw, dh, matrix int, full bool) {
	if sw == dw && sh == dh {
		nv12ToRGBA(dst, y[sy*yStride+sx:], yStride, uv[sy/2*uvStride+sx:], uvStride, dw, dh, matrix, full)
		return
	}
	need := nv12Size(dw, dh)
	if cap(s.nv12) < need {
		s.nv12 = make([]byte, need)
	}
	buf := s.nv12[:need]
	if cap(s.starts) < dw+1 {
		s.starts, s.ends = make([]int, dw+1), make([]int, dw+1)
	}
	starts, ends := s.starts[:dw+1], s.ends[:dw+1]

	for x := 0; x < dw; x++ {
		starts[x] = sx + x*sw/dw
		ends[x] = max(starts[x]+1, sx+(x+1)*sw/dw)
	}
	for row := 0; row < dh; row++ {
		r0 := sy + row*sh/dh
		r1 := max(r0+1, sy+(row+1)*sh/dh)
		out := buf[row*dw : row*dw+dw]
		for x := range out {
			sum, n := 0, 0
			for r := r0; r < r1; r++ {
				line := y[r*yStride+starts[x] : r*yStride+ends[x]]
				for _, v := range line {
					sum += int(v)
				}
				n += len(line)
			}
			out[x] = byte(sum / n)
		}
	}

	cw, ch := dw/2, dh/2
	for x := 0; x < cw; x++ {
		starts[x] = sx/2 + x*(sw/2)/cw
		ends[x] = max(starts[x]+1, sx/2+(x+1)*(sw/2)/cw)
	}
	for row := 0; row < ch; row++ {
		r0 := sy/2 + row*(sh/2)/ch
		r1 := max(r0+1, sy/2+(row+1)*(sh/2)/ch)
		out := buf[dw*dh+row*dw : dw*dh+row*dw+dw]
		for x := 0; x < cw; x++ {
			su, sv, n := 0, 0, 0
			for r := r0; r < r1; r++ {
				line := uv[r*uvStride+starts[x]*2 : r*uvStride+ends[x]*2]
				for i := 0; i < len(line); i += 2 {
					su += int(line[i])
					sv += int(line[i+1])
				}
				n += len(line) / 2
			}
			out[x*2], out[x*2+1] = byte(su/n), byte(sv/n)
		}
	}
	nv12ToRGBA(dst, buf, dw, buf[dw*dh:], dw, dw, dh, matrix, full)
}
