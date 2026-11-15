// Package audio mixes everybody we listen to into one output and talks to the sound card.
package audio

import (
	"math"
	"sync"
	"sync/atomic"
)

// A voice starts after 60 ms is buffered and never holds more than 400 ms.
const (
	sampleRate  = 48000
	prebuffer   = sampleRate / 1000 * 60
	maxBuffered = sampleRate / 1000 * 400
)

type Source struct {
	mu      sync.Mutex
	buf     []int16
	playing bool
	level   float64
	gain    float64
	Name    string

	cur          float64
	rate         float64
	frac         float64
	fresh        bool
	rampIn       int
	lastL, lastR float64
	avg          float64
	tail         int

	underruns atomic.Int64
	overflows atomic.Int64
}

// SourceStats counts what went wrong with a source: callbacks that found less than they needed (each is a click) and
// pushes that had to throw the oldest sound away; BufferedMs is the fill now.
type SourceStats struct {
	Underruns, Overflows int64
	BufferedMs           int
}

func (s *Source) Stats() SourceStats {
	return SourceStats{Underruns: s.underruns.Load(), Overflows: s.overflows.Load(), BufferedMs: s.Buffered()}
}

func (s *Source) Push(pcm []int16) {
	s.mu.Lock()
	s.buf = append(s.buf, pcm...)
	if over := len(s.buf)/2 - maxBuffered; over > 0 {
		s.overflows.Add(1)
		s.buf = append(s.buf[:0], s.buf[over*2:]...)
	}
	s.mu.Unlock()
}

func (s *Source) SetGain(g float64) {
	s.mu.Lock()
	s.gain = g
	s.mu.Unlock()
}

func (s *Source) Level() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.level
}

func (s *Source) Buffered() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.buf) / 2 * 1000 / sampleRate
}

// The fill a source is kept between: the sender's clock is never the sound card's, and a queue that is left alone either runs
// dry (a click) or grows (a delay that has to be cut). Packets arrive 20 ms apart, so the queue swings by that much around its
// average. Within lowFill and highFill, which is where a healthy queue sits whatever its delay, the sound is played as it
// came; when the average (over about half a second) leaves them it is played a little slower or faster, by at most maxNudge,
// until it is back. A fraction of a percent is not heard; a gap or a cut is.
const (
	lowFill     = sampleRate / 1000 * 30
	highFill    = sampleRate / 1000 * 200
	lowRange    = sampleRate / 1000 * 10
	highRange   = sampleRate / 1000 * 100
	maxNudge    = 0.01
	nudgeStep   = 0.0004
	fillSmooth  = 0.02
	edgeSamples = 96
)

func (s *Source) mixInto(acc []int32, frames int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.playing && len(s.buf)/2 >= prebuffer {
		s.playing, s.fresh = true, true
		s.avg = float64(len(s.buf) / 2)
	}
	var sum float64
	n := 0
	from := 0
	if s.playing {
		n = s.render(acc, frames, &sum)
		if n < frames {
			s.playing = false
			s.underruns.Add(1)
			s.tail, from = 0, n
		}
	} else {
		s.cur = s.gain
	}
	s.drawTail(acc, from, frames)
	rms := 0.0
	if n > 0 {
		rms = math.Sqrt(sum/float64(n*2)) / 32768
	}
	if rms > s.level {
		s.level = rms
	} else {
		s.level = s.level*0.92 + rms*0.08
	}
}

// drawTail lets the sound that ran dry die away from where it stopped over edgeSamples frames, across blocks, instead of
// cutting off.
func (s *Source) drawTail(acc []int32, from, frames int) {
	for i := from; i < frames && s.tail < edgeSamples; i++ {
		w := 1 - float64(s.tail+1)/edgeSamples
		acc[2*i] += int32(s.lastL * w)
		acc[2*i+1] += int32(s.lastR * w)
		s.tail++
	}
}

// steer eases the playing speed toward what keeps the queue near its target.
func (s *Source) steer() {
	fill := float64(len(s.buf) / 2)
	s.avg += (fill - s.avg) * fillSmooth
	want := 1.0
	switch {
	case s.avg > highFill:
		want = 1 + min(maxNudge, (s.avg-highFill)/highRange*maxNudge)
	case s.avg < lowFill:
		want = 1 - min(maxNudge, (lowFill-s.avg)/lowRange*maxNudge)
	}
	switch {
	case s.rate < want-nudgeStep:
		s.rate += nudgeStep
	case s.rate > want+nudgeStep:
		s.rate -= nudgeStep
	default:
		s.rate = want
	}
}

// render adds up to frames of the queue to acc at the source's gain and speed, easing the gain over the block and the
// start and the end of the sound so neither is a click. It returns how many frames it made; fewer than asked means the
// queue ran dry.
func (s *Source) render(acc []int32, frames int, sum *float64) int {
	s.steer()
	g0, g1 := s.cur, s.gain
	s.cur = g1
	step := (g1 - g0) / float64(frames)
	avail := len(s.buf) / 2
	exact := s.rate == 1 && s.frac == 0
	if s.rate == 1 {
		s.frac = 0
	}
	pos := s.frac
	count := frames
	if exact {
		count = min(frames, avail)
	} else if can := int((float64(avail-1) - pos) / s.rate); can < frames {
		count = max(can, 0)
	}
	for n := 0; n < count; n++ {
		idx := int(pos)
		var l, r float64
		if exact {
			l, r = float64(s.buf[2*idx]), float64(s.buf[2*idx+1])
		} else {
			t := pos - float64(idx)
			l = float64(s.buf[2*idx])*(1-t) + float64(s.buf[2*idx+2])*t
			r = float64(s.buf[2*idx+1])*(1-t) + float64(s.buf[2*idx+3])*t
		}
		g := g0 + step*float64(n)
		if s.fresh && s.rampIn < edgeSamples {
			g *= float64(s.rampIn) / edgeSamples
			s.rampIn++
		}
		l, r = l*g, r*g
		acc[2*n] += int32(l)
		acc[2*n+1] += int32(r)
		*sum += l*l + r*r
		s.lastL, s.lastR = l, r
		pos += s.rate
	}
	if s.rampIn >= edgeSamples {
		s.fresh, s.rampIn = false, 0
	}
	n := count
	used := min(int(pos), avail)
	s.frac = pos - float64(int(pos))
	if used < avail {
		s.buf = append(s.buf[:0], s.buf[used*2:]...)
	} else {
		s.buf, s.frac = s.buf[:0], 0
	}
	return n
}

type Mixer struct {
	mu      sync.RWMutex
	sources map[*Source]struct{}
	acc     []int32
	clips   []*clipPlay

	deafened bool
	volume   float64
}

func NewMixer() *Mixer { return &Mixer{sources: map[*Source]struct{}{}, volume: 1} }

func (m *Mixer) NewSource(name string) *Source {
	s := &Source{Name: name, gain: 1, cur: 1, rate: 1, tail: edgeSamples}
	m.mu.Lock()
	m.sources[s] = struct{}{}
	m.mu.Unlock()
	return s
}

// Stats is how each source has done, by name.
func (m *Mixer) Stats() map[string]SourceStats {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]SourceStats, len(m.sources))
	for s := range m.sources {
		out[s.Name] = s.Stats()
	}
	return out
}

func (m *Mixer) Remove(s *Source) {
	m.mu.Lock()
	delete(m.sources, s)
	m.mu.Unlock()
}

func (m *Mixer) SetDeafened(d bool) {
	m.mu.Lock()
	m.deafened = d
	m.mu.Unlock()
}

func (m *Mixer) SetVolume(v float64) {
	m.mu.Lock()
	m.volume = v
	m.mu.Unlock()
}

func (m *Mixer) Mix(out []int16) {
	frames := len(out) / 2
	m.mu.Lock()
	if len(m.acc) < frames*2 {
		m.acc = make([]int32, frames*2)
	}
	acc := m.acc[:frames*2]
	for i := range acc {
		acc[i] = 0
	}
	for s := range m.sources {
		s.mixInto(acc, frames)
	}
	m.mixClips(acc)
	vol, deaf := m.volume, m.deafened
	m.mu.Unlock()

	for i, v := range acc {
		if deaf {
			out[i] = 0
			continue
		}
		out[i] = kneeClip(float64(v) * vol)
	}
}

// kneeClip leaves a sample alone up to three quarters of full scale and bends what is above it toward full scale, so a
// sum that is too loud is rounded off instead of cut square.
func kneeClip(f float64) int16 {
	const knee = 24576
	const room = 32767 - knee
	switch {
	case f > knee:
		return int16(knee + room*math.Tanh((f-knee)/room))
	case f < -knee:
		return int16(-knee - room*math.Tanh((-f-knee)/room))
	}
	return int16(f)
}
