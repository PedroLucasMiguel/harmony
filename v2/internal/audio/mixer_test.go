package audio

import (
	"math"
	"testing"
)

func stereo(frames int, v int16) []int16 {
	out := make([]int16, frames*2)
	for i := range out {
		out[i] = v
	}
	return out
}

func peak(pcm []int16) int {
	p := 0
	for _, v := range pcm {
		if int(v) > p {
			p = int(v)
		}
		if -int(v) > p {
			p = -int(v)
		}
	}
	return p
}

func TestSourceWaitsForItsPrebuffer(t *testing.T) {
	m := NewMixer()
	s := m.NewSource("a")
	out := make([]int16, 480*2)

	s.Push(stereo(1440, 1000))
	m.Mix(out)
	if peak(out) != 0 {
		t.Fatal("played before the prebuffer was there")
	}
	s.Push(stereo(1440, 1000))
	m.Mix(out)
	if peak(out) != 1000 {
		t.Fatalf("not playing with 60 ms buffered (peak %d)", peak(out))
	}
}

func TestMixSumsAndClips(t *testing.T) {
	m := NewMixer()
	a, b := m.NewSource("a"), m.NewSource("b")
	a.Push(stereo(4800, 12000))
	b.Push(stereo(4800, 9000))
	out := make([]int16, 480*2)
	m.Mix(out)
	if last := out[len(out)-2]; last != 21000 {
		t.Errorf("12000 + 9000 = %d", last)
	}
	for i := 0; i < 10; i++ {
		m.Mix(out)
	}
	a.Push(stereo(4800, 30000))
	b.Push(stereo(4800, 30000))
	m.Mix(out)
	if last := out[len(out)-2]; last < 32000 {
		t.Errorf("a loud sum came out as %d, want it held just under 32767", last)
	}
}

func TestDeafenAndRunDry(t *testing.T) {
	m := NewMixer()
	s := m.NewSource("a")
	s.Push(stereo(4800, 5000))
	out := make([]int16, 480*2)
	m.SetDeafened(true)
	m.Mix(out)
	if peak(out) != 0 {
		t.Error("heard something while deafened")
	}
	m.SetDeafened(false)
	for i := 0; i < 10; i++ {
		m.Mix(out)
	}
	s.Push(stereo(480, 5000))
	m.Mix(out)
	if peak(out) != 0 {
		t.Error("played 10 ms after running dry")
	}
}

func TestSourceBufferIsBounded(t *testing.T) {
	s := NewMixer().NewSource("a")
	for i := 0; i < 100; i++ {
		s.Push(stereo(960, 1))
	}
	if s.Buffered() > 400 {
		t.Errorf("%d ms buffered, the bound is 400", s.Buffered())
	}
}

func TestLevelFollowsTheVoice(t *testing.T) {
	m := NewMixer()
	s := m.NewSource("a")
	out := make([]int16, 480*2)
	s.Push(stereo(9600, 8000))
	for i := 0; i < 15; i++ {
		m.Mix(out)
	}
	if s.Level() < 0.2 {
		t.Errorf("level %.2f while talking", s.Level())
	}
	for i := 0; i < 200; i++ {
		m.Mix(out)
	}
	if s.Level() > 0.02 {
		t.Errorf("level %.3f long after they stopped", s.Level())
	}
}

func sine(from, frames int, freq float64) []int16 {
	out := make([]int16, frames*2)
	for i := 0; i < frames; i++ {
		v := int16(8000 * math.Sin(2*math.Pi*freq*float64(from+i)/sampleRate))
		out[2*i], out[2*i+1] = v, v
	}
	return out
}

func biggestStep(pcm []int16) int {
	worst := 0
	for i := 1; i < len(pcm)/2; i++ {
		d := int(pcm[2*i]) - int(pcm[2*i-2])
		worst = max(worst, d, -d)
	}
	return worst
}

// simulate plays seconds of a tone from a sender whose clock runs at (1+drift) of the sound card's, in the 20 ms packets
// the network brings and the 10 ms callbacks the card makes, and returns what came out and how the source did.
func simulate(seconds, drift float64) ([]int16, SourceStats) {
	m := NewMixer()
	s := m.NewSource("a")
	var out []int16
	block := make([]int16, 480*2)
	sent := 0
	var due float64
	for t := 0; t < int(seconds*100); t++ {
		due += 480 * (1 + drift)
		for due >= 960 {
			s.Push(sine(sent, 960, 440))
			sent += 960
			due -= 960
		}
		m.Mix(block)
		out = append(out, block...)
	}
	return out, s.Stats()
}

// A tone from a sender whose clock differs a little from the sound card's plays on without a gap or a cut, because the
// source speeds up or slows down by a fraction of a percent instead of running dry or throwing sound away.
func TestSourceFollowsASendersClock(t *testing.T) {
	for _, drift := range []float64{-0.004, 0, 0.004} {
		out, stats := simulate(60, drift)
		if stats.Underruns > 1 || stats.Overflows > 0 {
			t.Errorf("drift %+.3f: %d underruns and %d overflows in a minute", drift, stats.Underruns, stats.Overflows)
		}
		if step := biggestStep(out[48000:]); step > 1100 {
			t.Errorf("drift %+.3f: a step of %d between samples in a 440 Hz tone", drift, step)
		}
	}
}

func mixBlocks(m *Mixer, n int) []int16 {
	var all []int16
	out := make([]int16, 480*2)
	for i := 0; i < n; i++ {
		m.Mix(out)
		all = append(all, out...)
	}
	return all
}

// Sound that runs dry in the middle of a wave fades out, and the sound that follows fades in: neither is a step.
func TestRunningDryAndStartingAreSmooth(t *testing.T) {
	m := NewMixer()
	s := m.NewSource("a")
	s.Push(sine(0, 3050, 440))
	all := mixBlocks(m, 8)
	s.Push(sine(3050, 4800, 440))
	all = append(all, mixBlocks(m, 12)...)
	if step := biggestStep(all); step > 1100 {
		t.Errorf("a step of %d between samples", step)
	}
}

// A change of volume, to silence included, is a ramp and not a step.
func TestGainChangesAreSmooth(t *testing.T) {
	m := NewMixer()
	s := m.NewSource("a")
	s.Push(sine(0, 9610, 440))
	all := mixBlocks(m, 3)
	s.SetGain(0)
	all = append(all, mixBlocks(m, 3)...)
	s.SetGain(1)
	all = append(all, mixBlocks(m, 3)...)
	if step := biggestStep(all); step > 1100 {
		t.Errorf("a step of %d between samples", step)
	}
}
