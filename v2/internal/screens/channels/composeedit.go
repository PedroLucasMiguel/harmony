package channels

import (
	"harmony/v2/internal/dm"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

const composerMaxLength = 4000

// endEdit leaves editing a message and puts back what was being written before it began.
func (s *Screen) endEdit() {
	st := &s.chat
	st.editing = nil
	st.input.SetValue(st.editDraft)
	st.editDraft = ""
}

// lastOwn is the newest message of this person in the log, as far as it is loaded, that can be edited.
func (s *Screen) lastOwn(m model) *hclient.ChatMessage {
	entries, _, _ := s.chatFeed().Messages(s.chat.channel)
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if e.Msg.UserID != m.state.Me.ID || e.Msg.Poll != nil {
			continue
		}
		if private := dmOf(e); private != nil && (private.Kind != dm.KindText || private.Unreadable) {
			continue
		}
		return &e.Msg
	}
	return nil
}

// composerKeys handles what the box does with Up and Escape before the box itself sees the keys: Up in an empty box edits the last message, Escape lets go of a reply or an edit.
func (s *Screen) composerKeys(c *widget.Context, m model) {
	st := &s.chat
	if !st.input.Focused(c) {
		return
	}
	in := &c.In
	if in.KeyUp && !in.Shift && !in.Ctrl && !in.Alt && !in.Super && st.input.Value() == "" && st.editing == nil && st.reply == nil && !s.hasPending() {
		if last := s.lastOwn(m); last != nil {
			s.beginEdit(last)
			in.KeyUp = false
		}
	}
	if c.EscapeBase() && !st.mention.open {
		switch {
		case st.editing != nil:
			s.endEdit()
			in.Escape = false
		case st.reply != nil:
			st.reply = nil
			in.Escape = false
		}
	}
}
