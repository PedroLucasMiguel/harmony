package native

import (
	"encoding/binary"
	"math"
)

// pcmFormat is how a device hands sound over: sample rate, channels, bits per sample, and whether samples are floats.
type pcmFormat struct {
	rate, channels, bits int
	float                bool
}

// audioConv turns a device's blocks into 48 kHz stereo 16 bit, carrying the position between blocks so a stream converts
// the same whatever the block sizes.
type audioConv struct {
	in   pcmFormat
	prev [2]float64
	pos  float64
	out  []int16
}

func newAudioConv(in pcmFormat) *audioConv { return &audioConv{in: in} }

func (c *audioConv) frameAt(src []byte, i int) (l, r float64) {
	bytes := c.in.bits / 8
	at := func(ch int) float64 {
		p := src[(i*c.in.channels+ch)*bytes:]
		switch {
		case c.in.float && bytes == 4:
			return float64(math.Float32frombits(binary.LittleEndian.Uint32(p)))
		case bytes == 2:
			return float64(int16(binary.LittleEndian.Uint16(p))) / 32768
		case bytes == 3:
			return float64(int32(uint32(p[0])<<8|uint32(p[1])<<16|uint32(p[2])<<24)>>8) / 8388608
		default:
			return float64(int32(binary.LittleEndian.Uint32(p))) / 2147483648
		}
	}
	switch c.in.channels {
	case 1:
		l = at(0)
		return l, l
	case 2:
		return at(0), at(1)
	default:
		return at(0), at(1)
	}
}

// convert returns the block as 48 kHz stereo; the slice is valid until the next call. silent makes the block zeros.
func (c *audioConv) convert(src []byte, frames int, silent bool) []int16 {
	step := float64(c.in.rate) / 48000
	c.out = c.out[:0]
	for ; c.pos < float64(frames); c.pos += step {
		i := int(c.pos)
		t := c.pos - float64(i)
		a0, a1 := c.sample(src, i-1, silent), c.sample(src, i, silent)
		c.out = append(c.out, toInt16(a0[0]+(a1[0]-a0[0])*t), toInt16(a0[1]+(a1[1]-a0[1])*t))
	}
	c.pos -= float64(frames)
	if frames > 0 {
		c.prev[0], c.prev[1] = c.last(src, frames, silent)
	}
	return c.out
}

func (c *audioConv) sample(src []byte, i int, silent bool) [2]float64 {
	switch {
	case i < 0:
		return c.prev
	case silent:
		return [2]float64{}
	}
	l, r := c.frameAt(src, i)
	return [2]float64{l, r}
}

func (c *audioConv) last(src []byte, frames int, silent bool) (float64, float64) {
	if silent {
		return 0, 0
	}
	return c.frameAt(src, frames-1)
}

func toInt16(v float64) int16 {
	switch {
	case v >= 1:
		return 32767
	case v <= -1:
		return -32768
	}
	return int16(v * 32767)
}
