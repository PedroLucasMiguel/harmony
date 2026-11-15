package audio

import "math"

const (
	bucketSeconds = 1.0
	buckets       = 8
	smoothSeconds = 0.04
)

// levelTracker remembers the quietest and loudest the smoothed level has been over the last few seconds: the first is the room, the second is the voice.
type levelTracker struct {
	smooth, heard, elapsed float64
	bucketMin, bucketMax   float64
	mins, maxes            [buckets - 1]float64
	count                  int
}

func newLevelTracker() levelTracker { return levelTracker{bucketMin: math.Inf(1)} }

func (t *levelTracker) update(level, seconds float64) {
	if t.heard == 0 {
		t.smooth = level
	} else {
		t.smooth += (level - t.smooth) * (1 - math.Exp(-seconds/smoothSeconds))
	}
	t.heard += seconds
	t.bucketMin = math.Min(t.bucketMin, t.smooth)
	t.bucketMax = math.Max(t.bucketMax, t.smooth)
	t.elapsed += seconds
	if t.elapsed < bucketSeconds {
		return
	}
	if t.count == len(t.mins) {
		copy(t.mins[:], t.mins[1:])
		copy(t.maxes[:], t.maxes[1:])
		t.count--
	}
	t.mins[t.count], t.maxes[t.count] = t.bucketMin, t.bucketMax
	t.count++
	t.elapsed, t.bucketMin, t.bucketMax = 0, math.Inf(1), 0
}

func (t *levelTracker) floor() float64 {
	v := t.bucketMin
	for _, m := range t.mins[:t.count] {
		v = math.Min(v, m)
	}
	return v
}

func (t *levelTracker) peak() float64 {
	v := t.bucketMax
	for _, m := range t.maxes[:t.count] {
		v = math.Max(v, m)
	}
	return v
}

const (
	autoMin         = 0.0008
	autoMax         = 0.06
	aboveFloor      = 3.0
	leastAboveFloor = 1.6
	shareOfVoice    = 0.35
)

// autoThreshold finds the noise gate's threshold from the sound itself: above the room's noise and below the voice.
type autoThreshold struct {
	tracker levelTracker
	value   float64
}

func newAutoThreshold() autoThreshold {
	return autoThreshold{tracker: newLevelTracker(), value: autoMax}
}

func (a *autoThreshold) update(level, seconds float64) {
	a.tracker.update(level, seconds)
	floor, peak := a.tracker.floor(), a.tracker.peak()
	threshold := floor * aboveFloor
	if peak > 0 {
		threshold = math.Max(floor*leastAboveFloor, math.Min(threshold, peak*shareOfVoice))
	}
	a.value = math.Min(autoMax, math.Max(autoMin, threshold))
}

const (
	agcTarget       = 0.1
	agcMaxGain      = 31.6
	agcMinGain      = 0.25
	agcFallDBPerSec = 40.0
	agcRiseDBPerSec = 6.0
	agcNoiseCeiling = 0.02
	voiceOverFloor  = 2.5
	voiceLeast      = 0.0006
	agcCeiling      = 0.95
	limiterKnee     = 0.8
)

func toDB(x float64) float64    { return 20 * math.Log10(x) }
func fromDB(db float64) float64 { return math.Pow(10, db/20) }

// softLimit squeezes what passes the knee towards 1, smoothly, so nothing is clipped flat.
func softLimit(s float32) float32 {
	a := s
	if a < 0 {
		a = -a
	}
	if a <= limiterKnee {
		return s
	}
	const room = 1 - limiterKnee
	squeezed := limiterKnee + room*float32(math.Tanh(float64(a-limiterKnee)/room))
	if s < 0 {
		return -squeezed
	}
	return squeezed
}

// agc is automatic gain control: a gain that follows the voice, so that a quiet microphone is brought up and a loud one down.
type agc struct {
	tracker levelTracker
	gain    float64
	applied float64
	voice   float64
}

func newAGC() agc { return agc{tracker: newLevelTracker(), gain: 1, applied: 1} }

func (a *agc) reset() { a.gain, a.applied = 1, 1 }

// next works out the gain for one piece of sound and returns it at the piece's start and end.
func (a *agc) next(rms, peak, seconds float64) (from, to float64) {
	from = a.applied
	a.tracker.update(rms, seconds)
	floor := a.tracker.floor()
	isVoice := a.tracker.heard > 0.3 && rms > math.Max(floor*voiceOverFloor, voiceLeast)
	wanted := a.gain
	if isVoice {
		tau := 0.4
		if rms > a.voice {
			tau = 0.05
		}
		if a.voice == 0 {
			a.voice = rms
		} else {
			a.voice += (rms - a.voice) * (1 - math.Exp(-seconds/tau))
		}
		most := agcMaxGain
		if a.tracker.heard > 1 && floor > 0 {
			most = math.Min(agcMaxGain, math.Max(1, agcNoiseCeiling/floor))
		}
		ideal := math.Min(most, math.Max(agcMinGain, agcTarget/a.voice))
		here, there := toDB(a.gain), toDB(ideal)
		rate := agcRiseDBPerSec
		if there < here {
			rate = agcFallDBPerSec
		}
		step := rate * seconds
		wanted = fromDB(here + math.Min(step, math.Max(-step, there-here)))
	}
	a.gain = math.Min(agcMaxGain, math.Max(agcMinGain, wanted))
	to = a.gain
	if peak*to > agcCeiling {
		to = math.Max(agcCeiling/peak, agcMinGain)
	}
	a.applied = to
	return from, to
}
