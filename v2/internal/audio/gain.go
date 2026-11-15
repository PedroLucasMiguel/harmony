package audio

import "math"

// ApplyGain scales a block of samples in place, clipping instead of wrapping.
func ApplyGain(pcm []int16, gain float64) {
	if gain == 1 {
		return
	}
	for i, v := range pcm {
		pcm[i] = int16(math.Max(math.MinInt16, math.Min(math.MaxInt16, float64(v)*gain)))
	}
}
