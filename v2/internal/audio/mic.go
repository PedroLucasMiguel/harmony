package audio

import (
	"math"
	"sync"
	"sync/atomic"

	"harmony/v2/internal/rnnoise"
)

const (
	micBlock       = sampleRate / 50
	micQueue       = 8
	gateWindow     = 1024
	gateHold       = sampleRate * 3 / 10
	gateOpenTau    = 0.005
	gateCloseTau   = 0.04
	volumeTau      = 0.01
	levelFallSecs  = 0.025
	levelFall      = 0.55
	speakOn        = 0.0075
	speakOff       = 0.0035
	speakHold      = sampleRate * 4 / 10
	speakRelease   = 0.918
	quietLevelFall = 0.5
)

// Config is how the microphone is processed; Threshold is an RMS between 0 and 1, and 0 is no noise gate at all.
type Config struct {
	Gain      float64
	Threshold float64
	Auto      bool
	AGC       bool
	Suppress  Suppression
}

// Mic is the microphone chain: noise suppression, automatic gain, input volume and the noise gate. Frames go in from the sound card's thread, are processed on a
// goroutine of their own, and come out of the two callbacks: tap before the gate (what a voice message records) and send after it (what the call carries).
type Mic struct {
	tap, send func(frame []int16)
	quietWhen func() bool

	cfgMu sync.Mutex
	cfg   atomic.Pointer[Config]

	in, free chan *micFrame
	quit     chan struct{}
	done     chan struct{}
	once     sync.Once

	level     atomic.Uint64
	threshold atomic.Uint64
	agcGain   atomic.Uint64
	open      atomic.Bool
	speaking  atomic.Bool

	w worker
}

type micFrame struct {
	pcm [micBlock]int16
	n   int
}

type worker struct {
	x, pre, gate [micBlock]float32
	out          [micBlock]int16
	squares      [gateWindow]float64
	slot         int
	total        float64
	levelSquare  float64
	clock        int64
	openUntil    int64
	gateGain     float64
	volume       float64
	isOpen       bool
	auto         autoThreshold
	agc          agc
	sup          *suppressor
	envelope     float64
	speakUntil   int64
	isSpeaking   bool
}

// NewMic starts the chain; tap and send are called from its goroutine, with frames that are only valid during the call. While quiet returns true nobody
// will hear the microphone and nothing records it, so the chain sends silence and does no work.
func NewMic(tap, send func(frame []int16), quiet func() bool) *Mic {
	m := &Mic{tap: tap, send: send, quietWhen: quiet, in: make(chan *micFrame, micQueue), free: make(chan *micFrame, micQueue), quit: make(chan struct{}), done: make(chan struct{})}
	m.cfg.Store(&Config{Gain: 1})
	m.w.auto, m.w.agc, m.w.volume, m.w.isOpen = newAutoThreshold(), newAGC(), 1, true
	m.w.gateGain = 1
	m.open.Store(true)
	for range micQueue {
		m.free <- new(micFrame)
	}
	go m.run()
	return m
}

// Update changes the configuration; it applies from the next frame.
func (m *Mic) Update(change func(c *Config)) {
	m.cfgMu.Lock()
	defer m.cfgMu.Unlock()
	c := *m.cfg.Load()
	change(&c)
	m.cfg.Store(&c)
}

func (m *Mic) Config() Config { return *m.cfg.Load() }

// Push hands the chain a frame of 48 kHz mono sound; it never blocks, and drops the frame when the chain is behind.
func (m *Mic) Push(frame []int16) {
	for len(frame) > 0 {
		var f *micFrame
		select {
		case f = <-m.free:
		default:
			return
		}
		f.n = copy(f.pcm[:], frame)
		frame = frame[f.n:]
		select {
		case m.in <- f:
		default:
			m.free <- f
			return
		}
	}
}

// Level is how loud the sound is before the gate, 0 to 1, falling a little slower than it rises.
func (m *Mic) Level() float64 { return math.Float64frombits(m.level.Load()) }

// Threshold is where the gate is now: the set one, or the one the automatic sensitivity found; 0 when there is no gate.
func (m *Mic) Threshold() float64 { return math.Float64frombits(m.threshold.Load()) }

// AGCGain is the gain automatic gain control is applying, 1 when it is off.
func (m *Mic) AGCGain() float64 { return math.Float64frombits(m.agcGain.Load()) }

// Open is whether the gate lets the sound through.
func (m *Mic) Open() bool { return m.open.Load() }

// Speaking is whether what is sent is a voice: it goes on and off with a margin, as the ring round a speaker's picture does.
func (m *Mic) Speaking() bool { return m.speaking.Load() }

func (m *Mic) Close() {
	m.once.Do(func() { close(m.quit) })
	<-m.done
}

func (m *Mic) run() {
	defer close(m.done)
	defer m.w.dropSuppressor()
	for {
		select {
		case <-m.quit:
			return
		case f := <-m.in:
			m.process(f)
			m.free <- f
		}
	}
}

func (w *worker) dropSuppressor() {
	if w.sup != nil {
		w.sup.close()
		w.sup = nil
	}
}

func (m *Mic) process(f *micFrame) {
	w, n := &m.w, f.n
	if m.quietWhen != nil && m.quietWhen() {
		w.dropSuppressor()
		clear(w.out[:n])
		m.level.Store(math.Float64bits(m.Level() * quietLevelFall))
		m.open.Store(false)
		m.speaking.Store(false)
		m.send(w.out[:n])
		return
	}
	c := m.cfg.Load()
	x := w.x[:n]
	for i, v := range f.pcm[:n] {
		x[i] = float32(v) / int16Scale
	}
	if c.Suppress != SuppressOff && n%rnnoise.FrameSize == 0 {
		follow := c.Suppress == SuppressStrong
		if w.sup == nil {
			w.sup = newSuppressor(follow)
		} else if w.sup.follow != follow {
			w.sup.follow = follow
			w.sup.gain = 1
			if follow {
				w.sup.gain = 0
			}
		}
		w.sup.process(x)
	} else {
		w.dropSuppressor()
	}

	seconds := float64(n) / sampleRate
	var agcFrom, agcStep float32 = 1, 0
	if c.AGC {
		var sum float64
		var peak float32
		for _, v := range x {
			sum += float64(v) * float64(v)
			a := v
			if a < 0 {
				a = -a
			}
			peak = max(peak, a)
		}
		from, to := w.agc.next(math.Sqrt(sum/float64(n)), float64(peak), seconds)
		agcFrom, agcStep = float32(from), float32((to-from)/float64(n))
		m.agcGain.Store(math.Float64bits(to))
	} else {
		w.agc.reset()
		m.agcGain.Store(math.Float64bits(1))
	}

	threshold := c.Threshold
	if c.Auto {
		threshold = w.auto.value
	}
	thresholdSquare := threshold * threshold
	gateWanted := c.Auto || c.Threshold > 0
	openStep := 1 - math.Exp(-1/(gateOpenTau*sampleRate))
	closeStep := 1 - math.Exp(-1/(gateCloseTau*sampleRate))
	volumeStep := 1 - math.Exp(-1/(volumeTau*sampleRate))
	fall := math.Pow(levelFall, 1/(sampleRate*levelFallSecs))
	fallSquare := fall * fall

	for i, v := range x {
		sq := float64(v) * float64(v)
		w.total += sq - w.squares[w.slot]
		w.squares[w.slot] = sq
		if w.slot++; w.slot == gateWindow {
			w.slot = 0
		}
		w.clock++
		mean := math.Max(w.total, 0) / gateWindow
		w.levelSquare = math.Max(mean, w.levelSquare*fallSquare)
		if gateWanted {
			if mean >= thresholdSquare {
				w.openUntil = w.clock + gateHold
			}
			w.isOpen = w.clock < w.openUntil
		} else {
			w.isOpen = true
		}
		target, step := 0.0, closeStep
		if w.isOpen {
			target, step = 1, openStep
		}
		w.gateGain += (target - w.gateGain) * step
		w.volume += (c.Gain - w.volume) * volumeStep
		s := v * float32(w.volume) * (agcFrom + agcStep*float32(i))
		if c.AGC {
			s = softLimit(s)
		}
		w.pre[i] = s
		w.gate[i] = float32(w.gateGain)
	}
	if c.Auto {
		w.auto.update(math.Sqrt(math.Max(w.total, 0)/gateWindow), seconds)
	}
	m.level.Store(math.Float64bits(math.Sqrt(w.levelSquare)))
	m.threshold.Store(math.Float64bits(threshold))
	m.open.Store(w.isOpen)

	out := w.out[:n]
	if m.tap != nil {
		toInt16(out, w.pre[:n], nil)
		m.tap(out)
	}
	toInt16(out, w.pre[:n], w.gate[:n])
	m.trackSpeaking(out)
	m.send(out)
}

func toInt16(out []int16, x, gate []float32) {
	for i, v := range x {
		if gate != nil {
			v *= gate[i]
		}
		out[i] = int16(max(-32768, min(32767, v*int16Scale)))
	}
}

func (m *Mic) trackSpeaking(out []int16) {
	w := &m.w
	var sum float64
	for _, v := range out {
		sum += float64(v) * float64(v)
	}
	rms := math.Sqrt(sum/float64(len(out))) / int16Scale
	if rms > w.envelope {
		w.envelope = rms
	} else {
		w.envelope *= speakRelease
	}
	if w.envelope > speakOn {
		w.isSpeaking = true
		w.speakUntil = w.clock + speakHold
	} else if w.isSpeaking && w.envelope < speakOff && w.clock > w.speakUntil {
		w.isSpeaking = false
	}
	m.speaking.Store(w.isSpeaking)
}
