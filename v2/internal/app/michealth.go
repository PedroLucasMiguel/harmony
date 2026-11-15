package app

import (
	"context"
	"sync/atomic"
	"time"
)

const micHealthEvery = 5 * time.Second

// micWatch counts the frames the capture delivers, to notice a microphone that has gone quiet because it was unplugged.
type micWatch struct{ frames atomic.Uint64 }

// watchMic opens the microphone again, falling back to the system's own, when no frame has come for a check's length of time.
func (s *Session) watchMic(ctx context.Context) {
	last := s.micWatch.frames.Load()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(micHealthEvery):
		}
		now := s.micWatch.frames.Load()
		if now != last {
			last = now
			continue
		}
		s.mu.Lock()
		own := s.micOn && s.opt.Mic != nil && s.tap.feed.Load() == nil
		s.mu.Unlock()
		if !own {
			continue
		}
		s.logf("the microphone went quiet: opening it again")
		s.opt.Mic.Stop()
		if err := s.opt.Mic.Start(s.onMicFrame); err != nil {
			s.logf("could not open the microphone again: %v", err)
		}
		last = s.micWatch.frames.Load()
	}
}
