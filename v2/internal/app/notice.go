package app

import (
	"strings"
	"unicode/utf8"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/dm"
	"harmony/v2/internal/hclient"
)

// NoticeKind says what a Notice is about.
type NoticeKind int

const (
	NoticeMention NoticeKind = iota
	NoticeDirect
)

// Notice is something worth an operating system notification when the window is not in front: a message that names this
// person, or a private message. Do not disturb has already silenced it by the time it is handed out.
type Notice struct {
	Kind  NoticeKind
	Title string
	Body  string
	// Channel is the text channel of a mention; Conversation is the private conversation of a private message.
	Channel      int
	Conversation int
}

const noticeBodyMax = 140

func (s *Session) notify(n Notice) {
	if s.opt.OnNotice == nil || s.OwnStatus() == "dnd" {
		return
	}
	s.opt.OnNotice(n)
}

func (s *Session) mentioned(m hclient.ChatMessage) {
	s.PlayMention(audio.CueMention)
	s.mu.Lock()
	where := ""
	for _, c := range s.channels {
		if c.ID == m.ChannelID {
			where = c.Name
		}
	}
	s.mu.Unlock()
	title := m.Nickname
	if where != "" {
		title += " (#" + where + ")"
	}
	s.notify(Notice{Kind: NoticeMention, Title: title, Body: shorten(m.Body), Channel: m.ChannelID})
}

func (s *Session) directMessage(m *dm.Message, c *dm.Conversation) {
	s.PlayMention(audio.CueDM)
	title := s.nameOf(m.User)
	if c.Group && c.Title != "" {
		title += " (" + c.Title + ")"
	}
	s.notify(Notice{Kind: NoticeDirect, Title: title, Body: shorten(m.Body), Conversation: c.ID})
}

func (s *Session) nameOf(user int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.members {
		if a.ID == user {
			return a.Name()
		}
	}
	return ""
}

func shorten(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= noticeBodyMax {
		return text
	}
	return string([]rune(text)[:noticeBodyMax-1]) + "…"
}
