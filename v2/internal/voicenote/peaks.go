package voicenote

import "math"

// Bars is how many bars a waveform is drawn with.
const Bars = 40

// Info is what a sound looks like when it is drawn: how long it is and how loud it is along the way.
type Info struct {
	Frames int
	Peaks  [Bars]byte
}

// Seconds is the length.
func (i Info) Seconds() float64 { return float64(i.Frames) / rate }

// Analyse reads the whole track once, without keeping any of it, and leaves it at the start.
func Analyse(t Track) Info {
	info := Info{Frames: t.Frames()}
	if info.Frames == 0 {
		return info
	}
	var sum [Bars]float64
	var count [Bars]int
	buf := make([]int16, 4096*2)
	t.Seek(0)
	for at := 0; ; {
		n := t.Read(buf)
		if n == 0 {
			break
		}
		for i := 0; i < n; i++ {
			v := (float64(buf[2*i]) + float64(buf[2*i+1])) / 2 / 32768
			bar := min((at+i)*Bars/info.Frames, Bars-1)
			sum[bar] += v * v
			count[bar]++
		}
		at += n
	}
	t.Seek(0)
	var peaks [Bars]float64
	top := 1e-6
	for i := range peaks {
		peaks[i] = math.Sqrt(sum[i] / float64(max(count[i], 1)))
		top = max(top, peaks[i])
	}
	for i, p := range peaks {
		info.Peaks[i] = byte(math.Round(max(minBar, math.Sqrt(p/top)) * 255))
	}
	return info
}

const minBar = 0.12
