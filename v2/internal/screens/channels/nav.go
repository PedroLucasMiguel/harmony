package channels

import (
	"harmony/v2/internal/navhistory"
	"harmony/v2/internal/ui/redraw"
)

type navKind uint8

const (
	navText navKind = iota + 1
	navForum
	navPost
	navDM
)

// navPlace is somewhere that can be gone back to: a text channel, a forum or one of its posts, a private conversation.
type navPlace struct {
	kind          navKind
	channel, post int
}

type navState struct {
	trail navhistory.History[navPlace]
	last  navPlace
}

// here is where the person is now; ok is false on screens that are not a place (the list of private conversations).
func (s *Screen) here() (navPlace, bool) {
	switch {
	case s.dm.page:
		return navPlace{kind: navDM, channel: s.dm.current}, s.dm.current != 0
	case s.forum.channel != 0 && s.forum.post != 0:
		return navPlace{kind: navPost, channel: s.forum.channel, post: s.forum.post}, true
	case s.forum.channel != 0:
		return navPlace{kind: navForum, channel: s.forum.channel}, true
	case s.chat.channel > 0 && !s.chat.dm:
		return navPlace{kind: navText, channel: s.chat.channel}, true
	}
	return navPlace{}, false
}

// navNote records the place the frame found itself in; going back or forward lands on a place already in the trail, which changes nothing.
func (s *Screen) navNote() {
	p, ok := s.here()
	if !ok || p == s.nav.last {
		return
	}
	s.nav.last = p
	s.nav.trail.Push(p)
}

func (s *Screen) GoBack() { s.navStep(s.nav.trail.Back) }

func (s *Screen) GoForward() { s.navStep(s.nav.trail.Forward) }

// navStep takes steps until one lands on a place that still exists.
func (s *Screen) navStep(step func() (navPlace, bool)) {
	for {
		p, ok := step()
		if !ok {
			return
		}
		if s.exists(p) {
			s.navOpen(p)
			return
		}
		s.nav.trail.Drop(p)
		if p, ok := s.nav.trail.Current(); ok && s.exists(p) {
			return
		}
	}
}

func (s *Screen) exists(p navPlace) bool {
	if p.kind == navDM {
		return s.dm.feed != nil && s.Session.DM().Conversation(p.channel) != nil
	}
	for _, ch := range s.Session.State().Channels {
		if ch.ID == p.channel {
			return true
		}
	}
	return false
}

func (s *Screen) navOpen(p navPlace) {
	s.nav.last = p
	switch p.kind {
	case navDM:
		s.openConversation(p.channel)
	case navText:
		s.finishDM()
		s.openText(p.channel)
	case navForum:
		s.finishDM()
		if s.forum.channel == p.channel {
			s.closePost()
		} else {
			s.openForum(p.channel)
		}
	case navPost:
		s.finishDM()
		if s.forum.channel != p.channel {
			s.openForum(p.channel)
		}
		s.openPost(p.post)
	}
	redraw.Request()
}

// ServerTitle is the name the server goes by, for the title bar.
func (s *Screen) ServerTitle() string { return s.serverTitle() }
