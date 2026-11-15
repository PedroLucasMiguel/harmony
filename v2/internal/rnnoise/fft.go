package rnnoise

import "math"

type cpx struct{ r, i float32 }

// fft is the mixed radix transform (factors 5, 3, 4, 4, 4) over the 960 samples of a window, laid out as Opus's KISS FFT does.
type fft struct {
	bitrev   [windowSize]int32
	twiddles [windowSize]cpx
	scale    float32
	factors  [10]int
}

var transform = newFFT()

func newFFT() *fft {
	f := &fft{scale: 1.0 / windowSize, factors: [10]int{5, 192, 3, 64, 4, 16, 4, 4, 4, 1}}
	for i := range f.twiddles {
		phase := (-2 * math.Pi / windowSize) * float64(i)
		f.twiddles[i] = cpx{float32(math.Cos(phase)), float32(math.Sin(phase))}
	}
	f.bitrevTable(0, 0, 1, 1, f.factors[:])
	return f
}

func (f *fft) bitrevTable(out, at, stride, inStride int, factors []int) {
	p, m := factors[0], factors[1]
	factors = factors[2:]
	if m == 1 {
		for j := range p {
			f.bitrev[at] = int32(out + j)
			at += stride * inStride
		}
		return
	}
	for range p {
		f.bitrevTable(out, at, stride*p, inStride, factors)
		at += stride * inStride
		out += m
	}
}

func (f *fft) forward(in []cpx, out *[windowSize]cpx) {
	for i := range windowSize {
		x := in[i]
		out[f.bitrev[i]] = cpx{f.scale * x.r, f.scale * x.i}
	}
	var fstride [6]int
	fstride[0] = 1
	l := 0
	for {
		fstride[l+1] = fstride[l] * f.factors[2*l]
		l++
		if f.factors[2*l-1] == 1 {
			break
		}
	}
	m := f.factors[2*l-1]
	for i := l - 1; i >= 0; i-- {
		m2 := 1
		if i != 0 {
			m2 = f.factors[2*i-1]
		}
		switch f.factors[2*i] {
		case 3:
			f.bfly3(out, fstride[i], m, fstride[i], m2)
		case 4:
			f.bfly4(out, fstride[i], m, fstride[i], m2)
		case 5:
			f.bfly5(out, fstride[i], m, fstride[i], m2)
		}
		m = m2
	}
}

func mul(a, b cpx) cpx { return cpx{a.r*b.r - a.i*b.i, a.r*b.i + a.i*b.r} }

func (f *fft) bfly4(fout *[windowSize]cpx, fstride, m, n, mm int) {
	if m == 1 {
		for i := range n {
			o := fout[4*i : 4*i+4 : 4*i+4]
			s0 := cpx{o[0].r - o[2].r, o[0].i - o[2].i}
			o[0] = cpx{o[0].r + o[2].r, o[0].i + o[2].i}
			s1 := cpx{o[1].r + o[3].r, o[1].i + o[3].i}
			o[2] = cpx{o[0].r - s1.r, o[0].i - s1.i}
			o[0] = cpx{o[0].r + s1.r, o[0].i + s1.i}
			s1 = cpx{o[1].r - o[3].r, o[1].i - o[3].i}
			o[1] = cpx{s0.r + s1.i, s0.i - s1.r}
			o[3] = cpx{s0.r - s1.i, s0.i + s1.r}
		}
		return
	}
	m2, m3 := 2*m, 3*m
	for i := range n {
		base := i * mm
		var t1, t2, t3 int
		for j := range m {
			k := base + j
			s0 := mul(fout[k+m], f.twiddles[t1])
			s1 := mul(fout[k+m2], f.twiddles[t2])
			s2 := mul(fout[k+m3], f.twiddles[t3])
			s5 := cpx{fout[k].r - s1.r, fout[k].i - s1.i}
			fout[k] = cpx{fout[k].r + s1.r, fout[k].i + s1.i}
			s3 := cpx{s0.r + s2.r, s0.i + s2.i}
			s4 := cpx{s0.r - s2.r, s0.i - s2.i}
			fout[k+m2] = cpx{fout[k].r - s3.r, fout[k].i - s3.i}
			t1 += fstride
			t2 += fstride * 2
			t3 += fstride * 3
			fout[k] = cpx{fout[k].r + s3.r, fout[k].i + s3.i}
			fout[k+m] = cpx{s5.r + s4.i, s5.i - s4.r}
			fout[k+m3] = cpx{s5.r - s4.i, s5.i + s4.r}
		}
	}
}

func (f *fft) bfly3(fout *[windowSize]cpx, fstride, m, n, mm int) {
	m2 := 2 * m
	epi3 := f.twiddles[fstride*m]
	for i := range n {
		base := i * mm
		var t1, t2 int
		for j := range m {
			k := base + j
			s1 := mul(fout[k+m], f.twiddles[t1])
			s2 := mul(fout[k+m2], f.twiddles[t2])
			s3 := cpx{s1.r + s2.r, s1.i + s2.i}
			s0 := cpx{s1.r - s2.r, s1.i - s2.i}
			t1 += fstride
			t2 += fstride * 2
			fout[k+m] = cpx{fout[k].r - s3.r*.5, fout[k].i - s3.i*.5}
			s0.r *= epi3.i
			s0.i *= epi3.i
			fout[k] = cpx{fout[k].r + s3.r, fout[k].i + s3.i}
			fout[k+m2] = cpx{fout[k+m].r + s0.i, fout[k+m].i - s0.r}
			fout[k+m] = cpx{fout[k+m].r - s0.i, fout[k+m].i + s0.r}
		}
	}
}

func (f *fft) bfly5(fout *[windowSize]cpx, fstride, m, n, mm int) {
	ya, yb := f.twiddles[fstride*m], f.twiddles[fstride*2*m]
	for i := range n {
		base := i * mm
		for u := range m {
			k0 := base + u
			s0 := fout[k0]
			s1 := mul(fout[k0+m], f.twiddles[u*fstride])
			s2 := mul(fout[k0+2*m], f.twiddles[2*u*fstride])
			s3 := mul(fout[k0+3*m], f.twiddles[3*u*fstride])
			s4 := mul(fout[k0+4*m], f.twiddles[4*u*fstride])
			s7 := cpx{s1.r + s4.r, s1.i + s4.i}
			s10 := cpx{s1.r - s4.r, s1.i - s4.i}
			s8 := cpx{s2.r + s3.r, s2.i + s3.i}
			s9 := cpx{s2.r - s3.r, s2.i - s3.i}
			fout[k0] = cpx{fout[k0].r + (s7.r + s8.r), fout[k0].i + (s7.i + s8.i)}
			s5 := cpx{s0.r + (s7.r*ya.r + s8.r*yb.r), s0.i + (s7.i*ya.r + s8.i*yb.r)}
			s6 := cpx{s10.i*ya.i + s9.i*yb.i, -(s10.r*ya.i + s9.r*yb.i)}
			fout[k0+m] = cpx{s5.r - s6.r, s5.i - s6.i}
			fout[k0+4*m] = cpx{s5.r + s6.r, s5.i + s6.i}
			s11 := cpx{s0.r + (s7.r*yb.r + s8.r*ya.r), s0.i + (s7.i*yb.r + s8.i*ya.r)}
			s12 := cpx{s9.i*ya.i - s10.i*yb.i, s10.r*yb.i - s9.r*ya.i}
			fout[k0+2*m] = cpx{s11.r + s12.r, s11.i + s12.i}
			fout[k0+3*m] = cpx{s11.r - s12.r, s11.i - s12.i}
		}
	}
}
