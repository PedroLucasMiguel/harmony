package channels

import (
	"time"

	"harmony/v2/internal/ui/redraw"
)

// noteLife is how long an error or a note stays up: long enough for a sentence to be read twice.
const noteLife = 9 * time.Second

// startExpiry takes the text away after noteLife, unless another has been said since; the lock is held.
func (s *Screen) startExpiry() {
	s.errSeq++
	seq := s.errSeq
	time.AfterFunc(noteLife, func() {
		s.mu.Lock()
		if s.errSeq == seq {
			s.errText, s.isNote = "", false
		}
		s.mu.Unlock()
		redraw.Request()
	})
}
