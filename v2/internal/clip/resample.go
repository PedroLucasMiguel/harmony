package clip

// stereo48k turns interleaved samples of any rate and channel count into stereo at Rate, by linear interpolation.
func stereo48k(in []int16, rate, channels int) ([]int16, error) {
	if channels < 1 || rate < 1 {
		return nil, ErrUnsupported
	}
	frames := len(in) / channels
	if rate == Rate && channels == 2 {
		if len(in) > maxSamples {
			return nil, ErrTooLong
		}
		return in, nil
	}
	outFrames := int(int64(frames) * Rate / int64(rate))
	if outFrames*2 > maxSamples {
		return nil, ErrTooLong
	}
	right := min(1, channels-1)
	out := make([]int16, outFrames*2)
	step := float64(rate) / Rate
	for i := 0; i < outFrames; i++ {
		pos := float64(i) * step
		a := int(pos)
		b := min(a+1, frames-1)
		t := pos - float64(a)
		out[2*i] = lerp(in[a*channels], in[b*channels], t)
		out[2*i+1] = lerp(in[a*channels+right], in[b*channels+right], t)
	}
	return out, nil
}

func lerp(a, b int16, t float64) int16 { return int16(float64(a) + (float64(b)-float64(a))*t) }
