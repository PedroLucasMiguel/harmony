package native

import (
	"encoding/binary"
	"math"
	"testing"
)

func floatBlock(freq, rate float64, from, frames, channels int) []byte {
	b := make([]byte, frames*channels*4)
	for i := 0; i < frames; i++ {
		v := float32(0.5 * math.Sin(2*math.Pi*freq*float64(from+i)/rate))
		for ch := 0; ch < channels; ch++ {
			binary.LittleEndian.PutUint32(b[(i*channels+ch)*4:], math.Float32bits(v))
		}
	}
	return b
}

// A tone converted from 44.1 kHz float in awkward block sizes comes out as the same smooth tone at 48 kHz stereo: no
// step at a block's edge, and the length follows the rates.
func TestConvertKeepsATonesShapeAcrossBlocks(t *testing.T) {
	c := newAudioConv(pcmFormat{rate: 44100, channels: 1, bits: 32, float: true})
	var out []int16
	from := 0
	for _, n := range []int{441, 100, 997, 441, 3, 2000} {
		out = append(out, c.convert(floatBlock(440, 44100, from, n, 1), n, false)...)
		from += n
	}
	frames := len(out) / 2
	if want := from * 48000 / 44100; frames < want-2 || frames > want+2 {
		t.Fatalf("%d frames, want about %d", frames, want)
	}
	for i := 1; i < frames; i++ {
		if d := int(out[2*i]) - int(out[2*i-2]); d > 1100 || d < -1100 {
			t.Fatalf("step of %d at frame %d", d, i)
		}
		if out[2*i] != out[2*i+1] {
			t.Fatalf("mono did not fill both sides at %d", i)
		}
	}
}

func TestConvertSixteenBitStereoAtTheRightRateKeepsItsSamples(t *testing.T) {
	c := newAudioConv(pcmFormat{rate: 48000, channels: 2, bits: 16})
	src := make([]byte, 4*4)
	for i, v := range []int16{100, -100, 2000, -2000, 30000, -30000, 5, 6} {
		binary.LittleEndian.PutUint16(src[i*2:], uint16(v))
	}
	out := c.convert(src, 4, false)
	if len(out) != 8 {
		t.Fatalf("%d samples", len(out))
	}
	if out[2] < 90 || out[2] > 110 || out[4] < 1990 || out[4] > 2010 || out[7] > -29900 {
		t.Errorf("samples changed: %v", out)
	}
}
