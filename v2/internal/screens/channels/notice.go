package channels

import (
	"harmony/v2/internal/app"
	"harmony/v2/internal/ui/widget"
)

// OpenNotice shows what a clicked desktop notification was about: the channel a mention was in, or the private conversation.
func (s *Screen) OpenNotice(c *widget.Context, n app.Notice) {
	switch n.Kind {
	case app.NoticeDirect:
		if !s.PrivateAvailable() {
			return
		}
		s.ensureFeed(c)
		s.openConversation(n.Conversation)
	default:
		if s.dm.page {
			s.dm.back = 0
			s.leavePrivate()
		}
		s.openText(n.Channel)
	}
}
