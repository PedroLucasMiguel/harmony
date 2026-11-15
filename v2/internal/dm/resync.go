package dm

import "context"

// Resync reads again what was said while the connection was down: the list of conversations and the latest page of
// every conversation that was opened.
func (s *Session) Resync(ctx context.Context) {
	if err := s.Refresh(ctx); err != nil {
		return
	}
	s.mu.Lock()
	ids := make([]int, 0, len(s.threads))
	for id := range s.threads {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.Reload(id)
	}
}
