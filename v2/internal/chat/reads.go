package chat

import (
	"slices"

	"harmony/v2/internal/hclient"
)

// readState is what the server says is new in each channel, kept up to date from what arrives.
type readState struct {
	marks map[int]hclient.ReadMark
	open  int
}

// SetUnread replaces what is known with what the server said at connection.
func (s *Store) SetUnread(list []hclient.ReadMark) {
	s.mu.Lock()
	s.reads.marks = make(map[int]hclient.ReadMark, len(list))
	for _, m := range list {
		s.reads.marks[m.ChannelID] = m
	}
	s.mu.Unlock()
	s.changed()
}

// Unread is what is new in a channel.
func (s *Store) Unread(channel int) hclient.ReadMark {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reads.marks[channel]
}

// SetOpen says which text channel is on screen: what arrives in it is read as it comes.
func (s *Store) SetOpen(channel int) {
	if channel < 0 {
		channel = s.forumOf(channel)
	}
	s.mu.Lock()
	s.reads.open = channel
	s.mu.Unlock()
}

func (s *Store) setMark(m hclient.ReadMark) {
	s.mu.Lock()
	if s.reads.marks == nil {
		s.reads.marks = map[int]hclient.ReadMark{}
	}
	s.reads.marks[m.ChannelID] = m
	s.mu.Unlock()
	s.changed()
}

func (s *Store) noteIncoming(m hclient.ChatMessage) {
	me := s.client.User
	if m.UserID == me.ID {
		return
	}
	if s.OnMention != nil && mentionsUser(m, me) {
		defer s.OnMention(m)
	}
	s.mu.Lock()
	if m.ChannelID == s.reads.open {
		s.mu.Unlock()
		s.keepForumRead(m.ChannelID)
		return
	}
	if s.reads.marks == nil {
		s.reads.marks = map[int]hclient.ReadMark{}
	}
	mark, known := s.reads.marks[m.ChannelID]
	if !known {
		mark = hclient.ReadMark{ChannelID: m.ChannelID, LastReadID: max(0, m.ID-1)}
	}
	mark.Unread++
	mark.LastID = max(mark.LastID, m.ID)
	if mentionsUser(m, me) {
		mark.Mentions++
	}
	s.reads.marks[m.ChannelID] = mark
	s.mu.Unlock()
	s.changed()
}

func (s *Store) noteDeleted(channel int) {
	s.mu.Lock()
	mark, ok := s.reads.marks[channel]
	if ok && channel != s.reads.open && mark.Unread > 0 {
		mark.Unread--
		s.reads.marks[channel] = mark
	}
	s.mu.Unlock()
	if ok {
		s.changed()
	}
}

// MentionsUser is whether a message is addressed to somebody: named, everybody, a role they hold, or an answer to them.
func MentionsUser(m hclient.ChatMessage, user hclient.User) bool { return mentionsUser(m, user) }

// UnreadTotals is how many messages are new in all the channels, and how many of them name the person.
func (s *Store) UnreadTotals() (unread, mentions int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.reads.marks {
		unread += m.Unread
		mentions += m.Mentions
	}
	return unread, mentions
}

// mentionsUser is whether a message is addressed to somebody: named, everybody, a role they hold, or an answer to them.
func mentionsUser(m hclient.ChatMessage, user hclient.User) bool {
	return m.MentionsEveryone ||
		slices.Contains(m.Mentions, user.ID) ||
		slices.ContainsFunc(m.MentionRoles, func(role int) bool { return slices.Contains(user.Roles, role) }) ||
		(m.Reply != nil && m.Reply.UserID == user.ID)
}

// Highlights is whether a message is lit for somebody: it names them or their role, or everybody, or answers them (not their own words unless they name themselves).
func Highlights(m hclient.ChatMessage, user hclient.User) bool {
	if !mentionsUser(m, user) {
		return false
	}
	return m.UserID != user.ID || m.MentionsEveryone || slices.Contains(m.Mentions, user.ID) ||
		slices.ContainsFunc(m.MentionRoles, func(role int) bool { return slices.Contains(user.Roles, role) })
}
