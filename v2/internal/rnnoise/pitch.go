package rnnoise

import "math"

const (
	pitchMinPeriod = 60
	pitchMaxPeriod = 768
	pitchFrameSize = 960
	pitchBufSize   = pitchMaxPeriod + pitchFrameSize
)

type pitchScratch struct {
	xcorr   [pitchMaxPeriod >> 1]float32
	x4      [pitchFrameSize >> 2]float32
	y4      [(pitchFrameSize + pitchMaxPeriod) >> 2]float32
	yy      [pitchMaxPeriod + 1]float32
	lowpass [pitchBufSize >> 1]float32
}

func innerProd(x, y []float32) float32 {
	var s0, s1, s2, s3 float32
	y = y[:len(x)]
	i := 0
	for ; i+4 <= len(x); i += 4 {
		s0 += x[i] * y[i]
		s1 += x[i+1] * y[i+1]
		s2 += x[i+2] * y[i+2]
		s3 += x[i+3] * y[i+3]
	}
	for ; i < len(x); i++ {
		s0 += x[i] * y[i]
	}
	return (s0 + s1) + (s2 + s3)
}

func findBestPitch(xcorr, y []float32, length, maxPitch int) (best [2]int) {
	var bestNum, bestDen [2]float32
	bestNum[0], bestNum[1] = -1, -1
	best[1] = 1
	var syy float32 = 1
	for j := range length {
		syy += y[j] * y[j]
	}
	for i := range maxPitch {
		if xcorr[i] > 0 {
			x16 := xcorr[i] * 1e-12
			num := x16 * x16
			if num*bestDen[1] > bestNum[1]*syy {
				if num*bestDen[0] > bestNum[0]*syy {
					bestNum[1], bestDen[1], best[1] = bestNum[0], bestDen[0], best[0]
					bestNum[0], bestDen[0], best[0] = num, syy, i
				} else {
					bestNum[1], bestDen[1], best[1] = num, syy, i
				}
			}
		}
		syy += y[i+length]*y[i+length] - y[i]*y[i]
		syy = max(1, syy)
	}
	return best
}

func fir5(x, num []float32, mem *[5]float32) {
	n0, n1, n2, n3, n4 := num[0], num[1], num[2], num[3], num[4]
	m0, m1, m2, m3, m4 := mem[0], mem[1], mem[2], mem[3], mem[4]
	for i, v := range x {
		sum := v
		sum += n0 * m0
		sum += n1 * m1
		sum += n2 * m2
		sum += n3 * m3
		sum += n4 * m4
		m4, m3, m2, m1, m0 = m3, m2, m1, m0, v
		x[i] = sum
	}
	*mem = [5]float32{m0, m1, m2, m3, m4}
}

func lpc4(ac *[5]float32) (lpc [4]float32) {
	const p = 4
	e := ac[0]
	if ac[0] == 0 {
		return
	}
	for i := range p {
		var rr float32
		for j := range i {
			rr += lpc[j] * ac[i-j]
		}
		rr += ac[i+1]
		r := -rr / e
		lpc[i] = r
		for j := 0; j < (i+1)>>1; j++ {
			t1, t2 := lpc[j], lpc[i-1-j]
			lpc[j] = t1 + r*t2
			lpc[i-1-j] = t2 + r*t1
		}
		e -= r * r * e
		if e < .001*ac[0] {
			break
		}
	}
	return
}

func (s *pitchScratch) downsample(x []float32, xlp []float32) {
	n := len(x) >> 1
	for i := 1; i < n; i++ {
		xlp[i] = .5 * (.5*(x[2*i-1]+x[2*i+1]) + x[2*i])
	}
	xlp[0] = .5 * (.5*x[1] + x[0])
	xlp = xlp[:n]

	var ac [5]float32
	fastN := n - 4
	for k := range 5 {
		ac[k] = innerProd(xlp[:fastN], xlp[k:])
	}
	for k := range 5 {
		var d float32
		for i := k + fastN; i < n; i++ {
			d += xlp[i] * xlp[i-k]
		}
		ac[k] += d
	}
	ac[0] *= 1.0001
	for i := 1; i <= 4; i++ {
		ac[i] -= ac[i] * (.008 * float32(i)) * (.008 * float32(i))
	}
	lpc := lpc4(&ac)
	var tmp float32 = 1
	for i := range 4 {
		tmp = .9 * tmp
		lpc[i] *= tmp
	}
	const c1 = .8
	lpc2 := [5]float32{lpc[0] + .8, lpc[1] + c1*lpc[0], lpc[2] + c1*lpc[1], lpc[3] + c1*lpc[2], c1 * lpc[3]}
	var mem [5]float32
	fir5(xlp, lpc2[:], &mem)
}

// search finds the pitch period of the downsampled history: x is the newest 480 samples, y the whole history.
func (s *pitchScratch) search(x, y []float32, length, maxPitch int) int {
	lag := length + maxPitch
	for j := range length >> 2 {
		s.x4[j] = x[2*j]
	}
	for j := range lag >> 2 {
		s.y4[j] = y[2*j]
	}
	xc := s.xcorr[:]
	for i := range maxPitch >> 2 {
		xc[i] = innerProd(s.x4[:length>>2], s.y4[i:])
	}
	best := findBestPitch(xc, s.y4[:], length>>2, maxPitch>>2)

	for i := range maxPitch >> 1 {
		xc[i] = 0
		if abs(i-2*best[0]) > 2 && abs(i-2*best[1]) > 2 {
			continue
		}
		xc[i] = max(-1, innerProd(x[:length>>1], y[i:]))
	}
	best = findBestPitch(xc, y, length>>1, maxPitch>>1)

	offset := 0
	if best[0] > 0 && best[0] < (maxPitch>>1)-1 {
		a, b, c := xc[best[0]-1], xc[best[0]], xc[best[0]+1]
		if c-a > .7*(b-a) {
			offset = 1
		} else if a-c > .7*(b-c) {
			offset = -1
		}
	}
	return 2*best[0] - offset
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func pitchGain(xy, xx, yy float32) float32 {
	return float32(float64(xy) / math.Sqrt(float64(1+xx*yy)))
}

var secondCheck = [16]int{0, 0, 3, 2, 3, 2, 5, 2, 3, 2, 3, 2, 5, 2, 3, 2}

// removeDoubling corrects a period that is a multiple of the real one, and returns the gain of the pitch.
func (s *pitchScratch) removeDoubling(x []float32, t0 *int, prevPeriod int, prevGain float32) float32 {
	maxPeriod := pitchMaxPeriod / 2
	minPeriod := pitchMinPeriod / 2
	*t0 /= 2
	prevPeriod /= 2
	n := pitchFrameSize / 2
	base := maxPeriod
	if *t0 >= maxPeriod {
		*t0 = maxPeriod - 1
	}
	t := *t0
	t0v := *t0
	at := func(i int) float32 { return x[base+i] }
	var xx, xy float32
	for i := range n {
		xx += at(i) * at(i)
		xy += at(i) * at(i-t0v)
	}
	yy := s.yy[:]
	yy[0] = xx
	run := xx
	for i := 1; i <= maxPeriod; i++ {
		run = run + at(-i)*at(-i) - at(n-i)*at(n-i)
		yy[i] = max(0, run)
	}
	curYY := yy[t0v]
	bestXY, bestYY := xy, curYY
	g := pitchGain(xy, xx, curYY)
	g0 := g
	for k := 2; k <= 15; k++ {
		t1 := (2*t0v + k) / (2 * k)
		if t1 < minPeriod {
			break
		}
		var t1b int
		if k == 2 {
			if t1+t0v > maxPeriod {
				t1b = t0v
			} else {
				t1b = t0v + t1
			}
		} else {
			t1b = (2*secondCheck[k]*t0v + k) / (2 * k)
		}
		var xy1, xy2 float32
		for i := range n {
			xy1 += at(i) * at(i-t1)
			xy2 += at(i) * at(i-t1b)
		}
		xy = .5 * (xy1 + xy2)
		yk := .5 * (yy[t1] + yy[t1b])
		g1 := pitchGain(xy, xx, yk)
		var cont float32
		if abs(t1-prevPeriod) <= 1 {
			cont = prevGain
		} else if abs(t1-prevPeriod) <= 2 && 5*k*k < t0v {
			cont = .5 * prevGain
		}
		thresh := max(.3, .7*g0-cont)
		if t1 < 3*minPeriod {
			thresh = max(.4, .85*g0-cont)
		} else if t1 < 2*minPeriod {
			thresh = max(.5, .9*g0-cont)
		}
		if g1 > thresh {
			bestXY, bestYY, t, g = xy, yk, t1, g1
		}
	}
	bestXY = max(0, bestXY)
	var pg float32 = 1
	if bestYY > bestXY {
		pg = bestXY / (bestYY + 1)
	}
	var xc [3]float32
	for k := range 3 {
		for i := range n {
			xc[k] += at(i) * at(i-(t+k-1))
		}
	}
	offset := 0
	if xc[2]-xc[0] > .7*(xc[1]-xc[0]) {
		offset = 1
	} else if xc[0]-xc[2] > .7*(xc[1]-xc[2]) {
		offset = -1
	}
	pg = min(pg, g)
	*t0 = max(2*t+offset, pitchMinPeriod)
	return pg
}
