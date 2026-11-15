package channels

import (
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/store"
)

// starSnapshotOf is a message as a star keeps it, with the title of the post it is in.
func (s *Screen) starSnapshotOf(msg *hclient.ChatMessage) store.StarredMessage {
	snap := starSnapshot(msg)
	switch {
	case msg.Title != "":
		snap.PostTitle = msg.Title
	case s.chat.channel < 0:
		snap.PostTitle = s.forum.title
	}
	return snap
}

// goToThread opens a message of a forum in its post, or goes to one of a text channel.
func (s *Screen) goToThread(channel, id, thread int) {
	if !s.isForum(channel) || s.chat.dm {
		s.goTo(channel, id)
		return
	}
	if thread == 0 {
		thread = id
	}
	if s.forum.channel != channel {
		s.openForum(channel)
	}
	if s.forum.post != thread {
		s.openPost(thread)
	}
	s.revealHere(s.chat.channel, id)
}

func (s *Screen) isForum(id int) bool {
	for _, ch := range s.Session.State().Channels {
		if ch.ID == id {
			return ch.Kind == "forum"
		}
	}
	return false
}

// revealHere takes the open thread's log to a message, reading back to it first.
func (s *Screen) revealHere(key, id int) {
	f := &s.chat.find
	f.jump = jumpState{}
	c := f.c
	s.Session.Chat().Reveal(key, id, func(found bool) {
		c.Post(func() {
			if found && s.chat.channel == key {
				f.jump.want = id
			} else if !found {
				s.say(c.T("app.that_message_is_no_longer"))
			}
		})
	})
}
