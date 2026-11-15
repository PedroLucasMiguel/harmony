package app

import (
	"math"

	"harmony/v2/internal/audio"
)

const micFrameSlots = 100

func (s *Session) startMic() {
	s.micFree = make(chan []int16, micFrameSlots)
	s.mic = audio.NewMic(s.tap.frame, s.sendMic, s.micInaudible)
	s.cues.percent.Store(100)
}

// Mic is the microphone chain, for the settings that shape it and the meter that shows it.
func (s *Session) Mic() *audio.Mic { return s.mic }

// sendMic queues a processed frame for the call; it runs on the chain's goroutine.
func (s *Session) sendMic(frame []int16) {
	var cp []int16
	select {
	case cp = <-s.micFree:
	default:
		cp = make([]int16, len(frame))
	}
	cp = append(cp[:0], frame...)
	select {
	case s.micFrames <- cp:
	default:
		s.recycleMic(cp)
	}
}

func (s *Session) recycleMic(frame []int16) {
	select {
	case s.micFree <- frame:
	default:
	}
}

// micInaudible is true while nobody could hear the microphone and nothing is recording it.
func (s *Session) micInaudible() bool {
	if s.tap.feed.Load() != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.joined != nil && (s.muted || s.deafened || !s.PTTGate())
}

// SetMicGain is how much the microphone is amplified before it is sent, 1 being as it is.
func (s *Session) SetMicGain(g float64) { s.mic.Update(func(c *audio.Config) { c.Gain = g }) }

// MicLevel is how loud the microphone is right now, from 0 to 1, before the noise gate; 0 while it is not being sent.
func (s *Session) MicLevel() float64 {
	if s.micInaudible() {
		return 0
	}
	return s.mic.Level()
}

// micSending is whether what the microphone picks up is a voice that goes out, given that it is not muted.
func (s *Session) micSending() bool { return s.PTTGate() && s.mic.Speaking() }

// GateThreshold is the RMS an input sensitivity from 0 to 100 stands for; 0 is no gate.
func GateThreshold(sensitivity int) float64 {
	if sensitivity <= 0 {
		return 0
	}
	return 0.0008 * math.Pow(60, float64(sensitivity)/100)
}
