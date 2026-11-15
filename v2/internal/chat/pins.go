package chat

import (
	"context"
	"slices"
	"sync/atomic"

	"harmony/v2/internal/hclient"
)

// pinBook is each channel's pinned messages, the one pinned last first, and whether the person may pin. Its lists are
// guarded by the store's lock and never written to once shared.
type pinBook struct {
	lists  map[int][]hclient.ChatMessage
	canPin atomic.Bool
}

func (b *pinBook) set(channel int, list []hclient.ChatMessage) {
	if b.lists == nil {
		b.lists = map[int][]hclient.ChatMessage{}
	}
	b.lists[channel] = list
}

// note applies a message as the server now has it: a new pin goes first, a pin that was edited stays where it is, an unpinned one goes.
func (b *pinBook) note(key int, m hclient.ChatMessage) {
	list := b.lists[key]
	at := slices.IndexFunc(list, func(p hclient.ChatMessage) bool { return p.ID == m.ID })
	switch {
	case at >= 0 && m.Pinned:
		list = slices.Clone(list)
		list[at] = m
	case at >= 0:
		list = slices.Delete(slices.Clone(list), at, at+1)
	case m.Pinned:
		list = append([]hclient.ChatMessage{m}, list...)
	default:
		return
	}
	b.set(key, list)
}

func (b *pinBook) drop(channel, id int) {
	list := b.lists[channel]
	if at := slices.IndexFunc(list, func(p hclient.ChatMessage) bool { return p.ID == id }); at >= 0 {
		b.set(channel, slices.Delete(slices.Clone(list), at, at+1))
	}
}

// Pinned is a channel's pinned messages, the one pinned last first. The slice is never written to again.
func (s *Store) Pinned(channel int) []hclient.ChatMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pins.lists[channel]
}

// SetCanPin says whether the server lets the person pin and unpin messages.
func (s *Store) SetCanPin(can bool) { s.pins.canPin.Store(can) }

func (s *Store) CanPin() bool { return s.pins.canPin.Load() }

// Pin pins a message, or lets it go; the server's echo is what changes the lists.
func (s *Store) Pin(ctx context.Context, id int, pinned bool) error {
	return s.client.Pin(ctx, id, pinned)
}
