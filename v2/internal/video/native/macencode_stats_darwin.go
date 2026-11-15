//go:build darwin

package native

import (
	"sync/atomic"
	"time"
)

// mxStat times pictures through the session. Output comes in the order pictures went in (no B frames), so a ring of the
// times they went in is enough to pair them.
type mxStat struct {
	at      [8]atomic.Int64
	in, out atomic.Uint64
	nanos   atomic.Int64
	frames  atomic.Uint64
	dropped atomic.Uint64
}

func (s *mxStat) submitted() {
	n := s.in.Add(1)
	s.at[n&7].Store(time.Now().UnixNano())
}

func (s *mxStat) rollback() { s.in.Add(^uint64(0)) }

func (s *mxStat) finished() {
	n := s.out.Add(1)
	if t := s.at[n&7].Load(); t != 0 {
		s.nanos.Add(max(0, time.Now().UnixNano()-t))
	}
	s.frames.Add(1)
}

func (e *vtEncoder) Stats() EncodeStats {
	return EncodeStats{Frames: e.stat.frames.Load(), EncodeSeconds: float64(e.stat.nanos.Load()) / 1e9, Dropped: e.stat.dropped.Load()}
}

// Stats is the running encoder's, zero before it exists.
func (c *macCapture) Stats() EncodeStats {
	if e := c.enc.Load(); e != nil {
		return e.Stats()
	}
	return EncodeStats{}
}
