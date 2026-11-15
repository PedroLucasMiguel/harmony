package app

import (
	"context"
	"sync/atomic"
	"time"

	"harmony/v2/internal/media"
)

const pingEvery = 4 * time.Second

// pingState is the microphone path being measured and its last round trip in milliseconds plus one, 0 while unknown.
type pingState struct {
	pub atomic.Pointer[media.VoicePublisher]
	ms  atomic.Int32
}

// Ping is the round trip to the media relay in milliseconds, and false while it is not known.
func (s *Session) Ping() (int, bool) {
	v := int(s.ping.ms.Load())
	return v - 1, v > 0
}

func (s *Session) pingLoop(ctx context.Context) {
	wait := time.Second
	for {
		select {
		case <-ctx.Done():
			s.ping.ms.Store(0)
			return
		case <-time.After(wait):
		}
		wait = pingEvery
		ms := int32(0)
		if pub := s.ping.pub.Load(); pub != nil {
			if rtt, ok := pub.RTT(); ok {
				ms = int32(rtt.Milliseconds()) + 1
			}
		}
		if s.ping.ms.Swap(ms) != ms {
			s.changed()
		}
	}
}
