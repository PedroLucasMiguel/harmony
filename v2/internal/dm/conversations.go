package dm

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

// rowLocked is a conversation as the server describes it, over what is known of it. Only the list carries the unread
// count and the read mark.
func (s *Session) rowLocked(c rawConversation, fromList bool) *Conversation {
	known := s.convs[c.ID]
	row := &Conversation{
		ID: c.ID, Group: c.Kind == "group", Members: c.UserIDs, Title: c.Title, Owner: c.OwnerID,
		CreatedAt: c.CreatedAt, LastAt: c.LastAt,
	}
	if !row.Group {
		row.Peer = s.me
		for _, id := range c.UserIDs {
			if id != s.me {
				row.Peer = id
			}
		}
	}
	if known != nil {
		row.Last, row.Unread, row.LastRead = known.Last, known.Unread, known.LastRead
		if row.LastAt == 0 {
			row.LastAt = known.LastAt
		}
		if row.Members == nil {
			row.Members = known.Members
		}
	}
	if fromList {
		row.Unread, row.LastRead, row.Last = c.Unread, c.LastRead, nil
	}
	return row
}

// keyIDs are the key ids that open these messages.
func keyIDs(raws []*rawMessage, ids []int) []int {
	for _, m := range raws {
		if m == nil {
			continue
		}
		ids = append(ids, m.SenderKey, m.RecipientKey)
		for _, r := range m.Reactions {
			ids = append(ids, r.SenderKey, r.RecipientKey)
		}
	}
	return ids
}

// know learns the keys behind sealed messages, asking the server for any this computer has not seen.
func (s *Session) know(ctx context.Context, keys []Key, ids []int) {
	s.mu.Lock()
	s.v.learn(keys)
	unknown := s.v.unknown(ids)
	s.mu.Unlock()
	for len(unknown) > 0 {
		n := min(len(unknown), 100)
		list := make([]string, n)
		for i, id := range unknown[:n] {
			list[i] = fmt.Sprint(id)
		}
		var out struct {
			Keys []Key `json:"keys"`
		}
		if s.call(ctx, "GET", "/api/keys/lookup?ids="+strings.Join(list, ","), nil, 200, &out) == nil {
			s.mu.Lock()
			s.v.learn(out.Keys)
			s.mu.Unlock()
		}
		unknown = unknown[n:]
	}
}

// Refresh reads the list of conversations again, each with its last message opened for the row.
func (s *Session) Refresh(ctx context.Context) error {
	if s.Status().State != Ready {
		return nil
	}
	var out struct {
		Conversations []rawConversation `json:"conversations"`
		Keys          []Key             `json:"keys"`
		Blocked       []int             `json:"blocked"`
	}
	if err := s.call(ctx, "GET", "/api/dms", nil, 200, &out); err != nil {
		return err
	}
	var lasts []*rawMessage
	for _, c := range out.Conversations {
		lasts = append(lasts, c.Last)
	}
	s.know(ctx, out.Keys, keyIDs(lasts, nil))
	s.mutate(func() {
		s.blocked = map[int]bool{}
		for _, id := range out.Blocked {
			s.blocked[id] = true
		}
		next := map[int]*Conversation{}
		for _, c := range out.Conversations {
			row := s.rowLocked(c, true)
			if c.Last != nil {
				s.raw[c.Last.ID] = c.Last
				row.Last = s.v.openMessage(c.Last, row.Peer)
			}
			next[c.ID] = row
		}
		for id := range s.convs {
			if next[id] == nil {
				s.forgetLocked(id)
			}
		}
		s.convs = next
	})
	return nil
}

// Open is the conversation with somebody, made if there is none yet.
func (s *Session) Open(ctx context.Context, peer int) (int, error) {
	var out struct {
		Conversation rawConversation `json:"conversation"`
	}
	status, raw, err := s.request(ctx, "POST", "/api/dms", map[string]int{"userId": peer})
	if err != nil {
		return 0, err
	}
	if status != 200 && status != 201 {
		return 0, refusal(status, raw)
	}
	if err := unmarshal(raw, &out); err != nil {
		return 0, err
	}
	s.mutate(func() {
		if s.convs[out.Conversation.ID] == nil {
			s.convs[out.Conversation.ID] = s.rowLocked(out.Conversation, false)
		}
	})
	return out.Conversation.ID, nil
}

// forgetLocked lets go of a conversation and everything held of it.
func (s *Session) forgetLocked(id int) {
	if ts := s.threads[id]; ts != nil {
		for _, m := range ts.messages {
			delete(s.raw, m.ID)
		}
		for _, pin := range ts.pinIDs {
			delete(s.raw, pin)
		}
	}
	if c := s.convs[id]; c != nil && c.Last != nil {
		delete(s.raw, c.Last.ID)
	}
	delete(s.threads, id)
	delete(s.convs, id)
	s.heldLocked()
}

// heldLocked tells the vault which messages are still held: it keeps its replay checks for those.
func (s *Session) heldLocked() {
	keep := make(map[int]bool, len(s.raw))
	for id := range s.raw {
		keep[id] = true
	}
	s.v.forgetAllBut(keep)
}

// Clear deletes the conversation for you alone; the other people keep every word.
func (s *Session) Clear(ctx context.Context, conversation int) error {
	if err := s.call(ctx, "POST", fmt.Sprintf("/api/dms/%d/clear", conversation), map[string]any{}, 200, nil); err != nil {
		return err
	}
	s.mutate(func() { s.forgetLocked(conversation) })
	return nil
}

// MarkRead moves your read mark to the newest message you have and returns at once; the server is told in the background
// (and your other windows with it). It is cheap to call every frame the conversation is on screen.
func (s *Session) MarkRead(conversation int) {
	v := s.snap()
	c := v.byID[conversation]
	if c == nil {
		return
	}
	newest := 0
	if th := v.threads[conversation]; th != nil && len(th.Messages) > 0 {
		newest = th.Messages[len(th.Messages)-1].ID
	} else if c.Last != nil {
		newest = c.Last.ID
	}
	if newest <= c.LastRead && c.Unread == 0 {
		return
	}
	s.mutate(func() {
		cur := s.convs[conversation]
		if cur == nil {
			return
		}
		cp := *cur
		cp.Unread, cp.LastRead = 0, max(cur.LastRead, newest)
		s.convs[conversation] = &cp
	})
	if newest > c.LastRead {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
			defer cancel()
			_, _, _ = s.request(ctx, "POST", fmt.Sprintf("/api/dms/%d/read", conversation), map[string]int{"upTo": newest})
		}()
	}
}

// SetBlocked blocks or unblocks somebody: while it holds, nothing passes between you either way.
func (s *Session) SetBlocked(ctx context.Context, user int, on bool) error {
	var out struct {
		Blocked []int `json:"blocked"`
	}
	if err := s.call(ctx, "POST", "/api/dms/blocks", map[string]any{"userId": user, "blocked": on}, 200, &out); err != nil {
		return err
	}
	s.mutate(func() {
		s.blocked = map[int]bool{}
		for _, id := range out.Blocked {
			s.blocked[id] = true
		}
	})
	return nil
}

// Groups.

// CreateGroup makes a group of these people (you are in it, and run it) and returns its conversation id.
func (s *Session) CreateGroup(ctx context.Context, title string, users []int) (int, error) {
	var out struct {
		Conversation rawConversation `json:"conversation"`
	}
	if err := s.call(ctx, "POST", "/api/dms/groups", map[string]any{"title": title, "userIds": users}, 201, &out); err != nil {
		return 0, err
	}
	s.mutate(func() { s.convs[out.Conversation.ID] = s.rowLocked(out.Conversation, false) })
	return out.Conversation.ID, nil
}

func (s *Session) groupAction(ctx context.Context, conversation int, path string, body any) error {
	var out struct {
		Conversation *rawConversation `json:"conversation"`
	}
	if err := s.call(ctx, "POST", fmt.Sprintf("/api/dms/%d/%s", conversation, path), body, 200, &out); err != nil {
		return err
	}
	if out.Conversation != nil {
		s.mutate(func() { s.adoptLocked(*out.Conversation) })
	}
	return nil
}

// adoptLocked takes what the server now says of a conversation's people, name and who runs it.
func (s *Session) adoptLocked(view rawConversation) {
	c := s.convs[view.ID]
	if c == nil {
		return
	}
	cp := *c
	if view.UserIDs != nil {
		cp.Members = view.UserIDs
	}
	cp.Title, cp.Owner = view.Title, view.OwnerID
	if view.LastAt != 0 {
		cp.LastAt = view.LastAt
	}
	s.convs[c.ID] = &cp
}

// AddMembers puts people in a group you run. They see what is said from then on.
func (s *Session) AddMembers(ctx context.Context, conversation int, users []int) error {
	return s.groupAction(ctx, conversation, "members", map[string]any{"userIds": users})
}

// RemoveMember takes somebody out of a group you run.
func (s *Session) RemoveMember(ctx context.Context, conversation, user int) error {
	return s.groupAction(ctx, conversation, "members/remove", map[string]any{"userId": user})
}

// Rename renames a group you run.
func (s *Session) Rename(ctx context.Context, conversation int, title string) error {
	return s.groupAction(ctx, conversation, "rename", map[string]any{"title": title})
}

// Leave goes out of a group; it leaves your list at once.
func (s *Session) Leave(ctx context.Context, conversation int) error {
	if err := s.call(ctx, "POST", fmt.Sprintf("/api/dms/%d/leave", conversation), map[string]any{}, 200, nil); err != nil {
		return err
	}
	s.mutate(func() { s.forgetLocked(conversation) })
	return nil
}

// Preview is the line a message shows in a conversation's row or quotes in a reply: its first non-blank line, cut short,
// or the name of its file. Empty for a message that does not open and for a call or group line.
func Preview(m *Message) string {
	if m == nil || m.Kind != KindText || m.Unreadable {
		return ""
	}
	for _, line := range strings.Split(m.Body, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			if r := []rune(line); len(r) > 80 {
				return string(r[:80])
			}
			return line
		}
	}
	if m.File != nil {
		return m.File.Name
	}
	return ""
}

func hasID(messages []*Message, id int) bool {
	return slices.ContainsFunc(messages, func(m *Message) bool { return m.ID == id })
}
