package chat

import (
	"context"
	"slices"
	"time"

	"harmony/v2/internal/hclient"
)

const revealPages = 20

// Reveal makes sure a message is in a channel's log, loading what lies between it and the newest message if it is far
// back, and says whether it could be found once it has finished.
func (s *Store) Reveal(channel, id int, done func(found bool)) {
	s.mu.Lock()
	f := s.feedOf(channel)
	if hasID(f.entries, id) {
		s.mu.Unlock()
		done(true)
		return
	}
	s.mu.Unlock()
	go func() { done(s.reveal(channel, id)) }()
}

func (s *Store) reveal(channel, id int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if page, err := s.page(ctx, channel, 0, id); err == nil && slices.ContainsFunc(page.Messages, func(m hclient.ChatMessage) bool { return m.ID == id }) {
		s.mu.Lock()
		f := s.feedOf(channel)
		f.loaded, f.more = true, true
		f.noteReply(page, nil)
		f.entries = merge(nil, page.Messages, f.entries)
		s.pins.set(channel, page.Pinned)
		s.mu.Unlock()
		s.changed()
		return true
	}
	for range revealPages {
		s.mu.Lock()
		f := s.feedOf(channel)
		if hasID(f.entries, id) {
			s.mu.Unlock()
			return true
		}
		if len(f.entries) == 0 {
			s.mu.Unlock()
			return false
		}
		oldest := f.entries[0].Msg.ID
		s.mu.Unlock()
		page, err := s.page(ctx, channel, oldest, 0)
		if err != nil || len(page.Messages) == 0 {
			return false
		}
		s.mu.Lock()
		f.more = len(page.Messages) >= pageSize
		f.entries = merge(nil, page.Messages, f.entries)
		s.mu.Unlock()
		s.changed()
	}
	return false
}

// merge is the messages of a page together with entries already held, oldest first; a held entry is kept over its page copy.
func merge(dst []*Entry, page []hclient.ChatMessage, held []*Entry) []*Entry {
	for i := range page {
		if !hasID(held, page[i].ID) {
			dst = append(dst, &Entry{Msg: page[i]})
		}
	}
	dst = append(dst, held...)
	slices.SortStableFunc(dst, func(a, b *Entry) int { return a.Msg.ID - b.Msg.ID })
	return dst
}
