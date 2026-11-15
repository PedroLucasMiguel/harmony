package app

import (
	"errors"
	"sync/atomic"

	"harmony/v2/internal/audio"
)

// micTap is a second listener on the microphone that a call already has open: recording a voice message while in a call opens no second device.
type micTap struct {
	feed   atomic.Pointer[func([]int16)]
	owns   bool
	silent *SilentMic
}

func (t *micTap) frame(samples []int16) {
	if f := t.feed.Load(); f != nil {
		(*f)(samples)
	}
}

// Mixer is where everything this session plays is mixed.
func (s *Session) Mixer() *audio.Mixer { return s.mixer }

// RecordMic hands the microphone's frames (mono, 48 kHz, volume applied) to feed until the returned stop is called. In a call it listens to the open capture; otherwise it opens the microphone and stop closes it again.
func (s *Session) RecordMic(feed func([]int16)) (stop func(), err error) {
	s.mu.Lock()
	if s.tap.feed.Load() != nil {
		s.mu.Unlock()
		return nil, errors.New("a recording is already going")
	}
	s.tap.feed.Store(&feed)
	open := !s.micOn
	if open {
		s.micOn, s.tap.owns = true, true
	}
	s.mu.Unlock()
	if open {
		mic := s.opt.Mic
		if mic == nil {
			s.tap.silent = &SilentMic{}
			mic = s.tap.silent
		}
		if err := mic.Start(s.onMicFrame); err != nil {
			s.tap.feed.Store(nil)
			s.mu.Lock()
			s.micOn, s.tap.owns = false, false
			s.mu.Unlock()
			return nil, err
		}
	}
	return s.stopRecording, nil
}

func (s *Session) stopRecording() {
	s.tap.feed.Store(nil)
	s.mu.Lock()
	closing := s.tap.owns && s.joined == nil
	if closing {
		s.micOn, s.tap.owns = false, false
	}
	s.mu.Unlock()
	if closing {
		s.stopMic()
	}
}

func (s *Session) stopMic() {
	if s.opt.Mic != nil {
		s.opt.Mic.Stop()
	} else if s.tap.silent != nil {
		s.tap.silent.Stop()
	}
}

// OpenSpeakers makes sure the sound output is running, for something played outside a call.
func (s *Session) OpenSpeakers() {
	if s.opt.StartSpeakers != nil {
		if err := s.opt.StartSpeakers(); err != nil {
			s.logf("sound output unavailable: %v", err)
		}
	}
}

// CloseSpeakers stops the sound output when nothing else needs it: not while in a call.
func (s *Session) CloseSpeakers() {
	s.mu.Lock()
	inCall := s.joined != nil
	s.mu.Unlock()
	if !inCall && s.opt.StopSpeakers != nil {
		s.opt.StopSpeakers()
	}
}
