package dm

import (
	"context"
	"fmt"
	"slices"
)

// LoadOlder fetches the page before the oldest message held.
func (s *Session) LoadOlder(conversation int) {
	s.mu.Lock()
	ts := s.threads[conversation]
	if ts == nil || ts.loading || !ts.more || len(ts.messages) == 0 {
		s.mu.Unlock()
		return
	}
	ts.loading = true
	before := ts.messages[0].ID
	s.publishLocked()
	s.mu.Unlock()
	s.wake()
	go s.fetch(conversation, before)
}

// Reload reads a conversation's latest page again, as the server has it now.
func (s *Session) Reload(conversation int) {
	s.mutate(func() {
		ts := s.threads[conversation]
		if ts == nil {
			ts = &threadState{}
			s.threads[conversation] = ts
		}
		if s.convs[conversation] != nil && !ts.loading {
			ts.loading = true
			go s.fetch(conversation, 0)
		}
	})
}

func (s *Session) fetch(conversation, before int) {
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	path := fmt.Sprintf("/api/dms/%d/messages", conversation)
	if before > 0 {
		path += fmt.Sprintf("?before=%d", before)
	}
	var out struct {
		Messages []*rawMessage `json:"messages"`
		Pinned   []*rawMessage `json:"pinned"`
		Keys     []Key         `json:"keys"`
	}
	err := s.call(ctx, "GET", path, nil, 200, &out)
	if err == nil {
		s.know(ctx, out.Keys, keyIDs(out.Pinned, keyIDs(out.Messages, nil)))
	}
	s.mutate(func() {
		ts, c := s.threads[conversation], s.convs[conversation]
		if ts == nil || c == nil {
			return
		}
		ts.loading, ts.err = false, err
		if err != nil {
			return
		}
		if before > 0 {
			page := s.openAllLocked(out.Messages, c)
			ts.more = len(page) >= pageSize
			ts.messages = append(page, ts.messages...)
		} else {
			newest := 0
			if n := len(out.Messages); n > 0 {
				newest = out.Messages[n-1].ID
			}
			var kept []*Message
			for _, m := range ts.messages {
				if m.ID > newest {
					kept = append(kept, m)
				} else {
					delete(s.raw, m.ID)
				}
			}
			for _, pin := range ts.pinIDs {
				delete(s.raw, pin)
			}
			page := s.openAllLocked(out.Messages, c)
			ts.more = len(page) >= pageSize
			ts.messages = append(page, kept...)
			ts.pinIDs = ts.pinIDs[:0:0]
			for _, raw := range out.Pinned {
				s.raw[raw.ID] = raw
				ts.pinIDs = append(ts.pinIDs, raw.ID)
			}
			s.reopenPinsLocked(ts, c)
		}
		s.heldLocked()
	})
}

// openAllLocked keeps and opens a page of messages, oldest first.
func (s *Session) openAllLocked(raws []*rawMessage, c *Conversation) []*Message {
	out := make([]*Message, 0, len(raws))
	for _, raw := range raws {
		s.raw[raw.ID] = raw
		out = append(out, s.v.openMessage(raw, c.Peer))
	}
	return out
}

func (s *Session) reopenPinsLocked(ts *threadState, c *Conversation) {
	ts.pinned = make([]*Message, 0, len(ts.pinIDs))
	for _, id := range ts.pinIDs {
		if raw := s.raw[id]; raw != nil {
			ts.pinned = append(ts.pinned, s.v.openMessage(raw, c.Peer))
		}
	}
}

// Scan reads every message of a conversation, oldest first and opened, a page at a time: the only way to search one,
// because what the server holds of a private message is sealed. It does not touch what the conversation shows. limit is
// where to stop, newest first (0 for 20000), and onPage hears how many have been read so far.
func (s *Session) Scan(ctx context.Context, conversation, limit int, onPage func(read int)) ([]*Message, error) {
	if limit <= 0 {
		limit = 20_000
	}
	c := s.Conversation(conversation)
	if c == nil {
		return nil, &Error{Code: CodeNoConversation, Message: "No such conversation."}
	}
	var all []*Message
	before := 0
	for {
		path := fmt.Sprintf("/api/dms/%d/messages", conversation)
		if before > 0 {
			path += fmt.Sprintf("?before=%d", before)
		}
		var out struct {
			Messages []*rawMessage `json:"messages"`
			Keys     []Key         `json:"keys"`
		}
		if err := s.call(ctx, "GET", path, nil, 200, &out); err != nil {
			return nil, err
		}
		if len(out.Messages) == 0 {
			break
		}
		s.know(ctx, out.Keys, keyIDs(out.Messages, nil))
		s.mu.Lock()
		page := make([]*Message, 0, len(out.Messages))
		for _, raw := range out.Messages {
			page = append(page, s.v.openMessage(raw, c.Peer))
		}
		s.mu.Unlock()
		all = append(page, all...)
		if onPage != nil {
			onPage(len(all))
		}
		before = out.Messages[0].ID
		if len(out.Messages) < pageSize || len(all) >= limit {
			break
		}
	}
	return all, nil
}

// reopenAll opens everything held again, after a key said something new (a change, an acceptance).
func (s *Session) reopenAll() {
	s.mutate(func() {
		for id, ts := range s.threads {
			c := s.convs[id]
			if c == nil {
				continue
			}
			msgs := make([]*Message, len(ts.messages))
			for i, m := range ts.messages {
				msgs[i] = m
				if raw := s.raw[m.ID]; raw != nil {
					msgs[i] = s.v.openMessage(raw, c.Peer)
				}
			}
			ts.messages = msgs
			s.reopenPinsLocked(ts, c)
		}
		for id, c := range s.convs {
			if c.Last == nil || s.raw[c.Last.ID] == nil {
				continue
			}
			cp := *c
			cp.Last = s.v.openMessage(s.raw[c.Last.ID], c.Peer)
			s.convs[id] = &cp
		}
	})
}

// findLocked is a held message by id, with its conversation.
func (s *Session) findLocked(id int) (*Message, *Conversation) {
	for conversation, ts := range s.threads {
		for _, m := range ts.messages {
			if m.ID == id {
				return m, s.convs[conversation]
			}
		}
	}
	return nil, nil
}

// MessageByID is a message of a loaded conversation by id, or nil.
func (s *Session) MessageByID(id int) *Message {
	for _, th := range s.snap().threads {
		for _, m := range th.Messages {
			if m.ID == id {
				return m
			}
		}
	}
	return nil
}

// addLocked takes a message the server numbered: into the conversation's thread if it is loaded, and into its row.
func (s *Session) addLocked(raw *rawMessage, c *Conversation) *Message {
	s.raw[raw.ID] = raw
	m := s.v.openMessage(raw, c.Peer)
	if ts := s.threads[c.ID]; ts != nil && !hasID(ts.messages, raw.ID) {
		i, _ := slices.BinarySearchFunc(ts.messages, raw.ID, func(x *Message, id int) int { return x.ID - id })
		ts.messages = slices.Insert(slices.Clone(ts.messages), i, m)
	}
	cp := *c
	if c.Last == nil || c.Last.ID <= raw.ID {
		cp.Last = m
	}
	cp.LastAt = max(c.LastAt, raw.CreatedAt)
	s.convs[c.ID] = &cp
	s.heldLocked()
	return m
}

// refreshLocked opens a held message again from what the server last said of it, wherever it is shown.
func (s *Session) refreshLocked(id int) {
	raw := s.raw[id]
	if raw == nil {
		return
	}
	c := s.convs[raw.Conversation]
	if c == nil {
		return
	}
	m := s.v.openMessage(raw, c.Peer)
	if ts := s.threads[c.ID]; ts != nil {
		if i := slices.IndexFunc(ts.messages, func(x *Message) bool { return x.ID == id }); i >= 0 {
			ts.messages = slices.Clone(ts.messages)
			ts.messages[i] = m
		}
		wasPinned := slices.Contains(ts.pinIDs, id)
		switch {
		case raw.Pinned && !wasPinned:
			ts.pinIDs = append([]int{id}, ts.pinIDs...)
		case !raw.Pinned && wasPinned:
			ts.pinIDs = slices.DeleteFunc(slices.Clone(ts.pinIDs), func(x int) bool { return x == id })
		}
		s.reopenPinsLocked(ts, c)
	}
	if c.Last != nil && c.Last.ID == id {
		cp := *c
		cp.Last = m
		s.convs[c.ID] = &cp
	}
}

// dropLocked forgets a message the server deleted.
func (s *Session) dropLocked(id int) (lastGone bool) {
	delete(s.raw, id)
	for conversation, ts := range s.threads {
		ts.pinIDs = slices.DeleteFunc(slices.Clone(ts.pinIDs), func(x int) bool { return x == id })
		ts.pinned = slices.DeleteFunc(slices.Clone(ts.pinned), func(m *Message) bool { return m.ID == id })
		if !hasID(ts.messages, id) {
			continue
		}
		ts.messages = slices.DeleteFunc(slices.Clone(ts.messages), func(m *Message) bool { return m.ID == id })
		if c := s.convs[conversation]; c != nil && c.Last != nil && c.Last.ID == id {
			cp := *c
			cp.Last = nil
			if n := len(ts.messages); n > 0 {
				cp.Last = ts.messages[n-1]
			}
			s.convs[conversation] = &cp
		}
	}
	for _, c := range s.convs {
		if c.Last != nil && c.Last.ID == id {
			lastGone = true
		}
	}
	s.heldLocked()
	return lastGone
}
