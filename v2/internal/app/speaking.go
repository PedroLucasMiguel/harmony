package app

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.ctx.Done() }

// Speaking is a fingerprint of who is making sound in the call, louder than level: it changes when somebody starts
// or stops, so a caller can redraw only then.
func (s *Session) Speaking(level float64) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var print uint64
	mark := func(mid int) { print += (uint64(mid) + 1) * 0x9E3779B97F4A7C15 }
	for mid, p := range s.peers {
		if p.src.Level() > level {
			mark(mid)
		}
	}
	if s.joined != nil && !s.muted && !s.deafened && s.micSending() {
		mark(s.joined.Mid)
	}
	return print
}
