package app

import (
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/audio"
)

// pttTail keeps the microphone open a little after the key comes up, so the end of a word is not cut off.
const pttTail = 180 * time.Millisecond

type pttState struct {
	on   atomic.Bool
	held atomic.Bool

	mu    sync.Mutex
	timer *time.Timer
}

// SetPushToTalk turns push to talk on or off: on, the microphone sends silence unless the key is held.
func (s *Session) SetPushToTalk(on bool) {
	s.ptt.on.Store(on)
	if !on {
		s.ptt.cancel()
		s.ptt.held.Store(false)
	}
	s.changed()
}

// SetPTTHeld is told by the global hotkey that the push-to-talk key went down or up; it is safe from any goroutine.
func (s *Session) SetPTTHeld(held bool) {
	if !s.ptt.on.Load() {
		return
	}
	s.ptt.cancel()
	if held {
		if !s.ptt.held.Swap(true) {
			s.PlayCue(audio.CuePTTDown)
			s.changed()
		}
		return
	}
	s.ptt.mu.Lock()
	s.ptt.timer = time.AfterFunc(pttTail, func() {
		if s.ptt.held.Swap(false) {
			s.PlayCue(audio.CuePTTUp)
			s.changed()
		}
	})
	s.ptt.mu.Unlock()
}

func (p *pttState) cancel() {
	p.mu.Lock()
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	p.mu.Unlock()
}

// PTTGate says whether the microphone may be heard: always, unless push to talk is on and its key is not held.
func (s *Session) PTTGate() bool { return !s.ptt.on.Load() || s.ptt.held.Load() }

// PTTOn reports whether push to talk is on.
func (s *Session) PTTOn() bool { return s.ptt.on.Load() }

// PTTHeld reports whether the push-to-talk key is held, tail included.
func (s *Session) PTTHeld() bool { return s.ptt.held.Load() }
