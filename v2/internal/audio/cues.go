package audio

import "math"

// Cue is one of the little noises: arriving, leaving, going live, muting. They are synthesised, so nothing is shipped: a few notes of an additive voice.
type Cue int

const (
	CueJoin Cue = iota
	CueLeave
	CueConnect
	CueDisconnect
	CueStreamStart
	CueStreamStop
	CueCameraOn
	CueCameraOff
	CueMute
	CueUnmute
	CueDeafen
	CueUndeafen
	CuePTTDown
	CuePTTUp
	CueDM
	CueRing
	CueMention
	cueCount
)

type voice struct {
	partials [3][2]float64
	count    int
	body     float64
	settle   float64
}

var (
	bell  = voice{partials: [3][2]float64{{1, 1}, {2.76, 0.26}, {5.4, 0.09}}, count: 3, body: 0.45, settle: 1.02}
	pluck = voice{partials: [3][2]float64{{1, 1}, {3.9, 0.42}, {9.2, 0.07}}, count: 3, body: 0.18, settle: 1.0}
	tick  = voice{partials: [3][2]float64{{1, 1}}, count: 1, body: 0.1, settle: 1.0}
)

type note struct{ hz, delay float64 }

type cueSpec struct {
	voice  *voice
	notes  []note
	length float64
	level  float64
	slide  float64
	noise  float64
}

const (
	d4 = 293.66
	g4 = 392.0
	b4 = 493.88
	c5 = 523.25
	d5 = 587.33
	e5 = 659.25
	g5 = 783.99
	a5 = 880.0
	b5 = 987.77
	c6 = 1046.5
	d6 = 1174.66
	e6 = 1318.51
	g6 = 1567.98
)

var cueSpecs = [cueCount]cueSpec{
	CueJoin:        {voice: &bell, notes: []note{{g5, 0}, {c6, 0.1}}, length: 0.38, level: 1},
	CueLeave:       {voice: &pluck, notes: []note{{e5, 0}, {b4, 0.09}}, length: 0.3, level: 1},
	CueConnect:     {voice: &bell, notes: []note{{e5, 0}, {g5, 0.08}, {c6, 0.16}}, length: 0.5, level: 1},
	CueDisconnect:  {voice: &bell, notes: []note{{c6, 0}, {g5, 0.08}, {e5, 0.16}}, length: 0.42, level: 0.9},
	CueStreamStart: {voice: &bell, notes: []note{{a5, 0}, {e6, 0.07}, {a5 * 2, 0.14}}, length: 0.55, level: 0.9},
	CueStreamStop:  {voice: &bell, notes: []note{{a5 * 2, 0}, {e6, 0.07}, {a5, 0.14}}, length: 0.5, level: 0.85},
	CueCameraOn:    {voice: &pluck, notes: []note{{c6, 0}, {e6, 0.07}}, length: 0.24, level: 0.85},
	CueCameraOff:   {voice: &pluck, notes: []note{{e6, 0}, {c6, 0.07}}, length: 0.24, level: 0.8},
	CueMute:        {voice: &pluck, notes: []note{{e6, 0}, {g5, 0.05}}, length: 0.2, level: 0.85},
	CueUnmute:      {voice: &pluck, notes: []note{{g5, 0}, {e6, 0.05}}, length: 0.2, level: 0.85},
	CueDeafen:      {voice: &pluck, notes: []note{{b4, 0}, {d4, 0.07}}, length: 0.3, level: 0.95},
	CueUndeafen:    {voice: &pluck, notes: []note{{d4, 0}, {b4, 0.07}}, length: 0.3, level: 0.95},
	CuePTTDown:     {voice: &tick, notes: []note{{1500, 0}}, length: 0.045, level: 0.6, slide: 1.35, noise: 0.5},
	CuePTTUp:       {voice: &tick, notes: []note{{1150, 0}}, length: 0.05, level: 0.5, slide: 0.7, noise: 0.5},
	CueDM:          {voice: &bell, notes: []note{{e6, 0}, {e6, 0.13}}, length: 0.3, level: 0.8},
	CueRing:        {voice: &bell, notes: []note{{e6, 0}, {a5 * 2, 0.16}, {e6, 0.5}, {a5 * 2, 0.66}}, length: 0.55, level: 1.1},
	CueMention:     {voice: &bell, notes: []note{{a5, 0}, {d6, 0.08}, {g6, 0.16}}, length: 0.34, level: 0.9},
}

// cuePeak is the loudest a cue gets at 100%, as a share of full scale.
const cuePeak = 0.32

// expRamp is the value of an exponential ramp from a to b over [t0, t1] at time t, held at b afterwards.
func expRamp(a, b, t0, t1, t float64) float64 {
	if t >= t1 {
		return b
	}
	return a * math.Pow(b/a, (t-t0)/(t1-t0))
}

// SynthCue renders a cue as stereo samples at the mixer's rate, with the sound effects volume (0 to 2) applied.
func SynthCue(c Cue, volume float64) []int16 {
	if c < 0 || c >= cueCount || volume <= 0 {
		return nil
	}
	spec := &cueSpecs[c]
	level := min(volume, 2) * cuePeak * spec.level
	last := spec.notes[len(spec.notes)-1].delay
	total := int((last+spec.length+0.05)*sampleRate) + 1
	mono := make([]float64, total)
	rng := uint32(2463534242)
	for _, n := range spec.notes {
		renderNote(mono, spec, n, level, &rng)
	}
	out := make([]int16, total*2)
	for i, v := range mono {
		s := int16(softClip(v) * 32767)
		out[2*i], out[2*i+1] = s, s
	}
	return out
}

func renderNote(mono []float64, spec *cueSpec, n note, level float64, rng *uint32) {
	v := spec.voice
	start := int(n.delay * sampleRate)
	length := int(spec.length*sampleRate) + int(0.02*sampleRate)
	attack := 0.006
	if spec.slide != 0 {
		attack = 0.002
	}
	var phase [3]float64
	var noiseGain float64
	var z1, z2 float64
	var b0, b1, b2, a1, a2 float64
	if spec.noise > 0 {
		w0 := 2 * math.Pi * n.hz * 2 / sampleRate
		alpha := math.Sin(w0) / (2 * 1.1)
		a0 := 1 + alpha
		b0, b1, b2, a1, a2 = alpha/a0, 0, -alpha/a0, -2*math.Cos(w0)/a0, (1-alpha)/a0
	}
	for i := 0; i < length && start+i < len(mono); i++ {
		t := float64(i) / sampleRate
		var env float64
		switch {
		case t >= spec.length:
			env = 0.0001
		case t < attack:
			env = expRamp(0.0001, level, 0, attack, t)
		case t < spec.length*0.35:
			env = expRamp(level, level*v.body, attack, spec.length*0.35, t)
		default:
			env = expRamp(level*v.body, 0.0001, spec.length*0.35, spec.length, t)
		}
		var sum float64
		for p := 0; p < v.count; p++ {
			mult, weight := v.partials[p][0], v.partials[p][1]
			pitch := n.hz * mult
			var f float64
			if spec.slide != 0 {
				f = expRamp(pitch, pitch*spec.slide, 0, spec.length, t)
			} else {
				f = expRamp(pitch*v.settle, pitch, 0, 0.04, t)
			}
			phase[p] += 2 * math.Pi * f / sampleRate
			w0 := weight
			if spec.noise > 0 {
				w0 = weight * (1 - spec.noise/2)
			}
			sum += math.Sin(phase[p]) * expRamp(w0, math.Max(0.0001, weight*0.05), 0, spec.length/mult, t)
		}
		if spec.noise > 0 {
			*rng = *rng*1664525 + 1013904223
			x := float64(int32(*rng)) / 2147483648
			y := b0*x + z1
			z1 = b1*x - a1*y + z2
			z2 = b2*x - a2*y
			burstEnd := math.Min(0.02, spec.length/2)
			noiseGain = expRamp(spec.noise, 0.0001, 0, burstEnd, t)
			sum += y * noiseGain
		}
		mono[start+i] += sum * env
	}
}

// softClip is the limiter every cue goes through, so two landing together cannot clip: it starts at -6 dB and never reaches 1.
func softClip(x float64) float64 {
	const knee = 0.5
	a := math.Abs(x)
	if a <= knee {
		return x
	}
	y := knee + (1-knee)*math.Tanh((a-knee)/(1-knee))
	return math.Copysign(y, x)
}
