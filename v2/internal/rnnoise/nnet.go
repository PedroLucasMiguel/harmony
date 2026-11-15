package rnnoise

type rnnState struct {
	conv1  [65 * 2]float32
	conv2  [128 * 2]float32
	states [3][hidden]float32
	// Scratch for one frame, so that nothing is allocated while it runs.
	tmp1, tmp2 [hidden]float32
	in1        [hidden]float32
	in2        [hidden]float32
	zrh, recur [3 * hidden]float32
}

func tanhApprox(x float32) float32 {
	const (
		n0, n1, n2 = 952.52801514, 96.39235687, 0.60863042
		d0, d1, d2 = 952.72399902, 413.36801147, 11.88600922
	)
	x2 := x * x
	num := (n2*x2+n1)*x2 + n0
	den := (d2*x2+d1)*x2 + d0
	num = num * x / den
	return max(-1, min(1, num))
}

func sigmoidApprox(x float32) float32 { return .5 + .5*tanhApprox(.5*x) }

func (l *linear) apply(out, in []float32) {
	if l.idx != nil {
		sparseGemv(out[:l.out], l.weights, l.idx, in)
	} else {
		denseGemv(out[:l.out], l.weights, in[:l.in])
	}
	for i, b := range l.bias {
		out[i] += b
	}
	if l.diag != nil {
		m := l.in
		for i := range m {
			v := in[i]
			out[i] += l.diag[i] * v
			out[i+m] += l.diag[i+m] * v
			out[i+2*m] += l.diag[i+2*m] * v
		}
	}
}

func denseGemv(out, w, in []float32) {
	clear(out)
	rows := len(out)
	j := 0
	for ; j+4 <= len(in); j += 4 {
		x0, x1, x2, x3 := in[j], in[j+1], in[j+2], in[j+3]
		c0 := w[j*rows : j*rows+rows : j*rows+rows]
		c1 := w[(j+1)*rows : (j+1)*rows+rows : (j+1)*rows+rows]
		c2 := w[(j+2)*rows : (j+2)*rows+rows : (j+2)*rows+rows]
		c3 := w[(j+3)*rows : (j+3)*rows+rows : (j+3)*rows+rows]
		for i := range out {
			v := out[i]
			v += c0[i] * x0
			v += c1[i] * x1
			v += c2[i] * x2
			v += c3[i] * x3
			out[i] = v
		}
	}
	for ; j < len(in); j++ {
		col := w[j*rows : j*rows+rows : j*rows+rows]
		xj := in[j]
		for i := range out {
			out[i] += col[i] * xj
		}
	}
}

func sparseGemv(out, w []float32, idx []int32, x []float32) {
	wi, ii := 0, 0
	for i := 0; i < len(out); i += 8 {
		cols := int(idx[ii])
		ii++
		var y0, y1, y2, y3, y4, y5, y6, y7 float32
		for range cols {
			pos := int(idx[ii])
			ii++
			xs := x[pos : pos+4 : pos+4]
			b := w[wi : wi+32 : wi+32]
			wi += 32
			x0, x1, x2, x3 := xs[0], xs[1], xs[2], xs[3]
			y0 += b[0] * x0
			y1 += b[1] * x0
			y2 += b[2] * x0
			y3 += b[3] * x0
			y4 += b[4] * x0
			y5 += b[5] * x0
			y6 += b[6] * x0
			y7 += b[7] * x0
			y0 += b[8] * x1
			y1 += b[9] * x1
			y2 += b[10] * x1
			y3 += b[11] * x1
			y4 += b[12] * x1
			y5 += b[13] * x1
			y6 += b[14] * x1
			y7 += b[15] * x1
			y0 += b[16] * x2
			y1 += b[17] * x2
			y2 += b[18] * x2
			y3 += b[19] * x2
			y4 += b[20] * x2
			y5 += b[21] * x2
			y6 += b[22] * x2
			y7 += b[23] * x2
			y0 += b[24] * x3
			y1 += b[25] * x3
			y2 += b[26] * x3
			y3 += b[27] * x3
			y4 += b[28] * x3
			y5 += b[29] * x3
			y6 += b[30] * x3
			y7 += b[31] * x3
		}
		o := out[i : i+8 : i+8]
		o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7] = y0, y1, y2, y3, y4, y5, y6, y7
	}
}

func (s *rnnState) conv1d(l *linear, out, mem, in []float32, inSize int) {
	tmp := s.in1[:l.in]
	if l.in != inSize {
		keep := l.in - inSize
		copy(tmp, mem[:keep])
		copy(tmp[keep:], in)
		l.apply(out, tmp)
		copy(mem, tmp[inSize:])
	} else {
		l.apply(out, in)
	}
	for i := range l.out {
		out[i] = tanhApprox(out[i])
	}
}

func (s *rnnState) gru(in, rec *linear, state, x []float32) {
	in.apply(s.zrh[:], x)
	rec.apply(s.recur[:], state)
	n := hidden
	z, r, h := s.zrh[:n], s.zrh[n:2*n], s.zrh[2*n:]
	for i := range 2 * n {
		s.zrh[i] = sigmoidApprox(s.zrh[i] + s.recur[i])
	}
	for i := range n {
		h[i] = tanhApprox(h[i] + s.recur[2*n+i]*r[i])
	}
	for i := range n {
		state[i] = z[i]*state[i] + (1-z[i])*h[i]
	}
}

func (s *rnnState) run(m *weights, gains *[numBands]float32, features *[numFeat]float32) float32 {
	s.conv1d(&m.conv1, s.tmp1[:128], s.conv1[:], features[:], 65)
	s.conv1d(&m.conv2, s.tmp2[:], s.conv2[:], s.tmp1[:128], 128)
	s.gru(&m.gruIn[0], &m.gruRec[0], s.states[0][:], s.tmp2[:])
	s.gru(&m.gruIn[1], &m.gruRec[1], s.states[1][:], s.states[0][:])
	s.gru(&m.gruIn[2], &m.gruRec[2], s.states[2][:], s.states[1][:])
	m.denseOut.apply(gains[:], s.states[2][:])
	for i := range gains {
		gains[i] = sigmoidApprox(gains[i])
	}
	var vad [1]float32
	m.vadDense.apply(vad[:], s.states[2][:])
	return sigmoidApprox(vad[0])
}
