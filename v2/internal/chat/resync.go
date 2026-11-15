package chat

import (
	"context"
	"slices"
	"time"
)

// Resync reads again what was said while the connection was down: the latest page of every log that was opened, with
// what was deleted or changed meanwhile, and the custom emoji.
func (s *Store) Resync() {
	s.mu.Lock()
	var keys []int
	for key, f := range s.feeds {
		if f.loaded && !f.gone {
			keys = append(keys, key)
		}
	}
	s.mu.Unlock()
	for _, key := range keys {
		go s.refetch(key)
	}
	go s.loadEmojis()
}

// refetch puts the latest page where the log's newest messages are. Older messages held are kept as they are, unless
// the page does not reach back to them: then there is a gap, and they are dropped to be loaded again on scrolling up.
// A message that came by event while the page was on its way is newer than it, and stays.
func (s *Store) refetch(key int) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	reply, err := s.page(ctx, key, 0, 0)
	if err != nil {
		return
	}
	page := reply.Messages
	s.mu.Lock()
	f := s.feedOf(key)
	f.noteReply(reply, nil)
	s.pins.set(key, reply.Pinned)
	fresh := make([]*Entry, 0, len(page)+len(f.entries))
	if len(page) > 0 {
		first, last := page[0].ID, page[len(page)-1].ID
		held := len(f.entries) > 0
		gap := len(page) >= pageSize && (!held || f.entries[len(f.entries)-1].Msg.ID < first)
		for _, e := range f.entries {
			if !gap && e.Msg.ID < first || e.Msg.ID > last {
				fresh = append(fresh, e)
			}
		}
		if gap || !held {
			f.more = len(page) >= pageSize
		}
	} else {
		f.more = false
	}
	for i := range page {
		fresh = append(fresh, &Entry{Msg: page[i]})
	}
	slices.SortStableFunc(fresh, func(a, b *Entry) int { return a.Msg.ID - b.Msg.ID })
	f.entries = fresh
	s.mu.Unlock()
	s.changed()
}
