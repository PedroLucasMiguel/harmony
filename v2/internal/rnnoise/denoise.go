package rnnoise

import "math"

var eband = [numBands + 2]int{0, 2, 4, 6, 8, 10, 12, 15, 18, 21, 24, 28, 32, 36, 41, 47, 53, 60, 68, 77, 87, 98, 110, 124, 140, 157, 176, 198, 223, 251, 282, 317, 356, 400}

// State is one stream's memory: call Process for each 480-sample frame in order. One State is used from one goroutine at a time.
type State struct {
	m           *weights
	analysisMem [FrameSize]float32
	synthMem    [FrameSize]float32
	pitchBuf    [pitchBufSize]float32
	lastGain    float32
	lastPeriod  int
	memHP       [2]float32
	lastG       [numBands]float32
	rnn         rnnState
	delayedX    [freqSize]cpx
	delayedP    [freqSize]cpx
	delayedEx   [numBands]float32
	delayedEp   [numBands]float32
	delayedExp  [numBands]float32

	pitch pitchScratch
	fx    [windowSize]cpx
	fy    [windowSize]cpx
	x, p  [freqSize]cpx
	win   [windowSize]float32
	gf    [freqSize]float32
	rf    [freqSize]float32
}

// New makes a State; the weights (4 MB) stay in memory while any State is open.
func New() *State { return &State{m: acquire()} }

// Close lets the weights go when it was the last State using them; the State is not used again.
func (s *State) Close() {
	release()
	s.m = nil
}

func bandEnergy(out *[numBands]float32, x *[freqSize]cpx) {
	var sum [numBands + 2]float32
	for i := range numBands + 1 {
		size := eband[i+1] - eband[i]
		for j := range size {
			frac := float32(j) / float32(size)
			c := x[eband[i]+j]
			tmp := c.r * c.r
			tmp += c.i * c.i
			sum[i] += (1 - frac) * tmp
			sum[i+1] += frac * tmp
		}
	}
	sum[1] = (sum[0] + sum[1]) * 2 / 3
	sum[numBands] = (sum[numBands] + sum[numBands+1]) * 2 / 3
	copy(out[:], sum[1:])
}

func bandCorr(out *[numBands]float32, x, p *[freqSize]cpx) {
	var sum [numBands + 2]float32
	for i := range numBands + 1 {
		size := eband[i+1] - eband[i]
		for j := range size {
			frac := float32(j) / float32(size)
			a, b := x[eband[i]+j], p[eband[i]+j]
			tmp := a.r * b.r
			tmp += a.i * b.i
			sum[i] += (1 - frac) * tmp
			sum[i+1] += frac * tmp
		}
	}
	sum[1] = (sum[0] + sum[1]) * 2 / 3
	sum[numBands] = (sum[numBands] + sum[numBands+1]) * 2 / 3
	copy(out[:], sum[1:])
}

// interpBandGain spreads the per-band values over the bins; the bins above 20 kHz stay zero.
func interpBandGain(g *[freqSize]float32, band *[numBands]float32) {
	for i := 1; i < numBands; i++ {
		size := eband[i+1] - eband[i]
		for j := range size {
			frac := float32(j) / float32(size)
			g[eband[i]+j] = (1-frac)*band[i-1] + frac*band[i]
		}
	}
	for j := 0; j < eband[1]; j++ {
		g[j] = band[0]
	}
	for j := eband[numBands]; j < eband[numBands+1]; j++ {
		g[j] = band[numBands-1]
	}
}

func (s *State) dct(out *[numFeat]float32, at int, in *[numBands]float32) {
	const scale = 0.30151134457776363 // sqrt(2/22)
	for i := range numBands {
		var sum float32
		for j := range numBands {
			sum += in[j] * s.m.dct[j*numBands+i]
		}
		out[at+i] = float32(float64(sum) * scale)
	}
}

func (s *State) applyWindow(x []float32) {
	for i := range FrameSize {
		x[i] *= s.m.halfWindow[i]
		x[windowSize-1-i] *= s.m.halfWindow[i]
	}
}

func (s *State) forward(out *[freqSize]cpx, in []float32) {
	for i, v := range in {
		s.fx[i] = cpx{v, 0}
	}
	transform.forward(s.fx[:], &s.fy)
	copy(out[:], s.fy[:freqSize])
}

func (s *State) inverse(out []float32, in *[freqSize]cpx) {
	copy(s.fx[:freqSize], in[:])
	for i := freqSize; i < windowSize; i++ {
		s.fx[i] = cpx{s.fx[windowSize-i].r, -s.fx[windowSize-i].i}
	}
	transform.forward(s.fx[:], &s.fy)
	out[0] = windowSize * s.fy[0].r
	for i := 1; i < windowSize; i++ {
		out[i] = windowSize * s.fy[windowSize-i].r
	}
}

func (s *State) features(x, p *[freqSize]cpx, ex, ep, exp *[numBands]float32, feat *[numFeat]float32, in []float32) (silence bool) {
	copy(s.win[:FrameSize], s.analysisMem[:])
	copy(s.win[FrameSize:], in)
	copy(s.analysisMem[:], in)
	s.applyWindow(s.win[:])
	s.forward(x, s.win[:])
	bandEnergy(ex, x)

	copy(s.pitchBuf[:], s.pitchBuf[FrameSize:])
	copy(s.pitchBuf[pitchBufSize-FrameSize:], in)
	lp := s.pitch.lowpass[:]
	s.pitch.downsample(s.pitchBuf[:], lp)
	idx := s.pitch.search(lp[pitchMaxPeriod>>1:], lp, pitchFrameSize, pitchMaxPeriod-3*pitchMinPeriod)
	idx = pitchMaxPeriod - idx
	gain := s.pitch.removeDoubling(lp, &idx, s.lastPeriod, s.lastGain)
	s.lastPeriod, s.lastGain = idx, gain

	pw := s.win[:]
	copy(pw, s.pitchBuf[pitchBufSize-windowSize-idx:])
	s.applyWindow(pw)
	s.forward(p, pw)
	bandEnergy(ep, p)
	bandCorr(exp, x, p)
	for i := range numBands {
		exp[i] = float32(float64(exp[i]) / math.Sqrt(.001+float64(ex[i]*ep[i])))
	}
	s.dct(feat, numBands, exp)
	feat[2*numBands] = float32(.01 * float64(idx-300))

	var ly [numBands]float32
	var e float32
	logMax, follow := float32(-2), float32(-2)
	for i := range numBands {
		v := float32(math.Log10(1e-2 + float64(ex[i])))
		v = max(logMax-7, max(follow-1.5, v))
		ly[i] = v
		logMax = max(logMax, v)
		follow = max(follow-1.5, v)
		e += ex[i]
	}
	if e < 0.04 {
		*feat = [numFeat]float32{}
		return true
	}
	s.dct(feat, 0, &ly)
	feat[0] -= 12
	feat[1] -= 4
	return false
}

func (s *State) synthesis(out []float32, y *[freqSize]cpx) {
	x := s.win[:]
	s.inverse(x, y)
	s.applyWindow(x)
	for i := range FrameSize {
		out[i] = x[i] + s.synthMem[i]
	}
	copy(s.synthMem[:], x[FrameSize:])
}

func (s *State) pitchFilter(x, p *[freqSize]cpx, ex, ep, exp, g *[numBands]float32) {
	var r, newE, norm [numBands]float32
	for i := range numBands {
		if exp[i] > g[i] {
			r[i] = 1
		} else {
			e2, g2 := float64(exp[i]*exp[i]), float64(g[i]*g[i])
			r[i] = float32(e2 * (1 - g2) / (.001 + g2*(1-e2)))
		}
		r[i] = float32(math.Sqrt(float64(min(1, max(0, r[i])))))
		r[i] *= float32(math.Sqrt(float64(ex[i]) / (1e-8 + float64(ep[i]))))
	}
	clear(s.rf[:])
	interpBandGain(&s.rf, &r)
	for i := range freqSize {
		x[i].r += s.rf[i] * p[i].r
		x[i].i += s.rf[i] * p[i].i
	}
	bandEnergy(&newE, x)
	for i := range numBands {
		norm[i] = float32(math.Sqrt(float64(ex[i]) / (1e-8 + float64(newE[i]))))
	}
	clear(s.rf[:])
	interpBandGain(&s.rf, &norm)
	for i := range freqSize {
		x[i].r *= s.rf[i]
		x[i].i *= s.rf[i]
	}
}

func (s *State) highpass(out, in []float32) {
	const b0, b1 = -2, 1
	a0, a1 := float64(float32(-1.99599)), float64(float32(0.99600))
	for i, xi := range in {
		yi := xi + s.memHP[0]
		s.memHP[0] = s.memHP[1] + float32(b0*float64(xi)-a0*float64(yi))
		s.memHP[1] = float32(b1*float64(xi) - a1*float64(yi))
		out[i] = yi
	}
}

// Process takes out of in (480 samples, 16-bit scale) what is not a voice, writes the result to out (the same length, a frame behind), and returns the
// network's probability, 0 to 1, that there was a voice in it. in and out may be the same slice.
func (s *State) Process(out, in []float32) float32 {
	var x [FrameSize]float32
	s.highpass(x[:], in)
	var ex, ep, exp [numBands]float32
	var feat [numFeat]float32
	silence := s.features(&s.x, &s.p, &ex, &ep, &exp, &feat, x[:])

	var vad float32
	if !silence {
		var g [numBands]float32
		vad = s.rnn.run(s.m, &g, &feat)
		s.pitchFilter(&s.delayedX, &s.delayedP, &s.delayedEx, &s.delayedEp, &s.delayedExp, &g)
		for i := range numBands {
			g[i] = max(g[i], .6*s.lastG[i])
			s.lastG[i] = g[i]
		}
		clear(s.gf[:])
		interpBandGain(&s.gf, &g)
		for i := range freqSize {
			s.delayedX[i].r *= s.gf[i]
			s.delayedX[i].i *= s.gf[i]
		}
	}
	s.synthesis(out, &s.delayedX)

	s.delayedX, s.delayedP = s.x, s.p
	s.delayedEx, s.delayedEp, s.delayedExp = ex, ep, exp
	return vad
}
