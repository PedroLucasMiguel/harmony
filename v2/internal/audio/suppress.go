package audio

import "harmony/v2/internal/rnnoise"

const (
	voiceLow   = 0.2
	voiceHigh  = 0.5
	holdFrames = 12
	openShare  = 0.7
	closeShare = 0.12
	quietFloor = 0.02
	int16Scale = 32768
)

// Suppression is how much of what is not a voice is taken out of the microphone.
type Suppression uint8

const (
	SuppressOff Suppression = iota
	// SuppressOn runs the network and sends what it leaves.
	SuppressOn
	// SuppressStrong also turns down the stretches the network is sure have no voice in them.
	SuppressStrong
)

// suppressor is RNNoise over the microphone, 10 ms at a time, and the gate that follows its idea of whether somebody is talking.
type suppressor struct {
	state  *rnnoise.State
	follow bool
	gain   float32
	hold   int
	in     [rnnoise.FrameSize]float32
}

func newSuppressor(follow bool) *suppressor {
	s := &suppressor{state: rnnoise.New(), follow: follow}
	if follow {
		s.gain = 0
	} else {
		s.gain = 1
	}
	return s
}

func (s *suppressor) close() { s.state.Close() }

// process cleans x in place; its length is a whole number of 10 ms frames.
func (s *suppressor) process(x []float32) {
	for at := 0; at+rnnoise.FrameSize <= len(x); at += rnnoise.FrameSize {
		s.frame(x[at : at+rnnoise.FrameSize])
	}
}

func (s *suppressor) frame(x []float32) {
	var peak float32
	for _, v := range x {
		if v < 0 {
			v = -v
		}
		peak = max(peak, v)
	}
	if peak*int16Scale < 1 {
		s.hold = 0
		s.gain = 1
		if s.follow {
			s.gain = 0
		}
		clear(x)
		return
	}
	for i, v := range x {
		s.in[i] = v * int16Scale
	}
	voice := s.state.Process(s.in[:], s.in[:])
	if !s.follow {
		for i, v := range s.in {
			x[i] = v / int16Scale
		}
		return
	}
	if voice >= voiceHigh {
		s.hold = holdFrames
	} else if s.hold > 0 {
		s.hold--
	}
	wanted := min(1, max(0, (voice-voiceLow)/(voiceHigh-voiceLow)))
	if s.hold > 0 {
		wanted = 1
	}
	target := max(quietFloor, wanted)
	from := s.gain
	share := float32(closeShare)
	if target > s.gain {
		share = openShare
	}
	s.gain += (target - s.gain) * share
	step := (s.gain - from) / rnnoise.FrameSize
	g := from
	for i, v := range s.in {
		g += step
		x[i] = v / int16Scale * g
	}
}
