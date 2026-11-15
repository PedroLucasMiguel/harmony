package rnnoise

import (
	"encoding/binary"
	"math"
	"os"
	"testing"
)

const testFrames = 150

// testSignal is silence, a voice, keyboard clicks, a hiss and another voice: what testdata/reference.bin was made from.
func testSignal() []float32 {
	rng := uint32(12345)
	noise := func() float64 {
		rng = rng*1664525 + 1013904223
		return float64(int32(rng)) / 2147483648.0
	}
	pcm := make([]float32, testFrames*FrameSize)
	phase := 0.0
	for n := range pcm {
		t := float64(n) / 48000
		f := n / FrameSize
		var v float64
		switch {
		case f < 20:
		case f < 60:
			phase += 2 * math.Pi * (140 + 12*math.Sin(2*math.Pi*5*t)) / 48000
			env := 0.6 + 0.4*math.Sin(2*math.Pi*3*t)
			for h := 1; h <= 20; h++ {
				v += env * 6000 / float64(h) * math.Sin(float64(h)*phase)
			}
			v = v/2 + 300*noise()
		case f < 80:
			v = 200 * noise()
			if k := n % 2400; k < 240 {
				v += 8000 * noise() * math.Exp(-float64(k)/60)
			}
		case f < 110:
			v = 1500 * noise()
		default:
			phase += 2 * math.Pi * 220 / 48000
			for h := 1; h <= 12; h++ {
				v += 3000 / float64(h) * math.Sin(float64(h)*phase+float64(h))
			}
			v = v/2 + 800*noise()
		}
		pcm[n] = float32(int16(math.Max(-32768, math.Min(32767, math.Round(v)))))
	}
	return pcm
}

// The reference is the C implementation (the same commit and model) run on testSignal with vectorisation off.
func TestAgainstC(t *testing.T) {
	ref, err := os.ReadFile("testdata/reference.bin")
	if err != nil {
		t.Fatal(err)
	}
	vadAt := func(f int) float64 { return float64(math.Float32frombits(binary.LittleEndian.Uint32(ref[4*f:]))) }
	sampleAt := func(i int) float64 { return float64(int16(binary.LittleEndian.Uint16(ref[4*testFrames+2*i:]))) }

	signal := testSignal()
	s := New()
	out := make([]float32, FrameSize)
	var worstVAD, worstSample float64
	for f := range testFrames {
		vad := s.Process(out, signal[f*FrameSize:(f+1)*FrameSize])
		worstVAD = max(worstVAD, math.Abs(float64(vad)-vadAt(f)))
		for i, v := range out {
			worstSample = max(worstSample, math.Abs(float64(v)-sampleAt(f*FrameSize+i)))
		}
	}
	if worstVAD > 2e-3 {
		t.Errorf("voice probability differs from the C code by %g", worstVAD)
	}
	if worstSample > 3 {
		t.Errorf("a sample differs from the C code by %g", worstSample)
	}
}

func BenchmarkProcess(b *testing.B) {
	signal := testSignal()
	s := New()
	out := make([]float32, FrameSize)
	b.ReportAllocs()
	for i := range b.N {
		f := 20 + i%40
		s.Process(out, signal[f*FrameSize:(f+1)*FrameSize])
	}
}
