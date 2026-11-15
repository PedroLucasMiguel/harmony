package audio

import (
	"math"
	"testing"
)

type chain struct {
	m    *Mic
	sent []int16
}

func newChain(c Config) *chain {
	ch := &chain{}
	ch.m = NewMic(nil, func(f []int16) { ch.sent = append(ch.sent[:0], f...) }, nil)
	ch.m.Update(func(old *Config) { *old = c })
	return ch
}

// feed pushes seconds of a 200 Hz tone of the given peak, or silence, one frame at a time through the real path.
func (c *chain) feed(peak, seconds float64) {
	frames := int(seconds * 50)
	f := &micFrame{n: micBlock}
	for range frames {
		for i := range f.pcm {
			f.pcm[i] = int16(peak * 32767 * math.Sin(2*math.Pi*200*float64(c.m.w.clock+int64(i))/sampleRate))
		}
		c.m.process(f)
	}
}

func (c *chain) sentRMS() float64 {
	var sum float64
	for _, v := range c.sent {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum/float64(len(c.sent))) / 32768
}

func TestGateOpensOnVoiceAndClosesAfterTheHold(t *testing.T) {
	c := newChain(Config{Gain: 1, Threshold: 0.02})
	defer c.m.Close()
	c.feed(0.001, 1)
	if c.m.Open() || c.sentRMS() > 1e-4 {
		t.Fatalf("a room at 0.001 passed a gate at 0.02: open=%v rms=%g", c.m.Open(), c.sentRMS())
	}
	c.feed(0.3, 0.3)
	if !c.m.Open() || c.sentRMS() < 0.1 {
		t.Fatalf("a voice did not open the gate: open=%v rms=%g", c.m.Open(), c.sentRMS())
	}
	c.feed(0.001, 0.2)
	if !c.m.Open() {
		t.Fatal("the gate closed inside the 300 ms hold")
	}
	c.feed(0.001, 0.6)
	if c.m.Open() || c.sentRMS() > 1e-3 {
		t.Fatalf("the gate did not close after the hold: open=%v rms=%g", c.m.Open(), c.sentRMS())
	}
}

func TestAutomaticGainBringsQuietVoiceUpAndLoudOneDown(t *testing.T) {
	speech := func(peak float64) *chain {
		c := newChain(Config{Gain: 1, AGC: true})
		for range 12 {
			c.feed(0.0004, 0.4)
			c.feed(peak, 0.6)
		}
		return c
	}
	quiet := speech(0.02)
	defer quiet.m.Close()
	if rms := quiet.sentRMS(); rms < 0.07 || rms > 0.14 {
		t.Errorf("a quiet voice came out at %g, want about 0.1", rms)
	}
	loud := speech(0.9)
	defer loud.m.Close()
	if rms := loud.sentRMS(); rms > 0.3 {
		t.Errorf("a loud voice came out at %g, want it turned down", rms)
	}
}

func TestAutomaticSensitivityLandsBetweenTheRoomAndTheVoice(t *testing.T) {
	c := newChain(Config{Gain: 1, Auto: true})
	defer c.m.Close()
	for range 6 {
		c.feed(0.004, 1.5)
		c.feed(0.3, 1.5)
	}
	room, voice := 0.004/math.Sqrt2, 0.3/math.Sqrt2
	if th := c.m.Threshold(); th <= room || th >= voice {
		t.Errorf("threshold %g is not between the room %g and the voice %g", th, room, voice)
	}
}

func BenchmarkMic(b *testing.B) {
	for _, tc := range []struct {
		name string
		cfg  Config
	}{
		{"volume", Config{Gain: 1}},
		{"gate+auto+agc", Config{Gain: 1, Auto: true, AGC: true}},
		{"rnnoise", Config{Gain: 1, Suppress: SuppressOn}},
		{"everything", Config{Gain: 1, Auto: true, AGC: true, Suppress: SuppressStrong}},
	} {
		b.Run(tc.name, func(b *testing.B) {
			c := newChain(tc.cfg)
			defer c.m.Close()
			f := &micFrame{n: micBlock}
			for i := range f.pcm {
				f.pcm[i] = int16(8000 * math.Sin(2*math.Pi*180*float64(i)/sampleRate))
			}
			b.ReportAllocs()
			for range b.N {
				c.m.process(f)
			}
		})
	}
}
