package channels

import (
	"errors"
	"sync/atomic"

	"harmony/v2/internal/app"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/ui/widget"
)

// roomFlow is joining a voice channel and being told what happened to the room: the notes the session leaves, the password a
// locked channel asks for, and the one join at a time.
type roomFlow struct {
	notes   []app.VoiceNote
	strings *i18n.Bundle
	joining atomic.Bool
}

// roomFrame runs once a frame: it loads what is kept of everybody's volume and shows what the session has to say.
func (s *Screen) roomFrame(c *widget.Context) {
	s.room.strings = c.Strings
	s.loadPeerVolumes()
	s.followDevices(s.seen.joined != nil)
	s.room.notes = s.Session.TakeVoiceNotes(s.room.notes[:0])
	for _, n := range s.room.notes {
		if n.Password != 0 {
			s.askPassword(c, n)
			continue
		}
		s.fail(errors.New(c.T(n.Key, n.Vars...)))
	}
}

// errorText is the words for an error, translated when it is one the person has to be told about.
func (s *Screen) errorText(err error) string {
	if errors.Is(err, app.ErrNotInVoice) && s.room.strings != nil {
		return s.room.strings.T("app.join_a_voice_channel_first")
	}
	return err.Error()
}

// joinVoice goes into a channel, ignoring the press when a join is already under way.
func (s *Screen) joinVoice(id int, password string) {
	if !s.room.joining.CompareAndSwap(false, true) {
		return
	}
	defer s.room.joining.Store(false)
	s.fail(nil)
	_ = s.Session.JoinWith(id, password)
}

func (s *Screen) askPassword(c *widget.Context, n app.VoiceNote) {
	name := ""
	for _, ch := range s.seen.channels {
		if ch.ID == n.Password {
			name = ch.Name
		}
	}
	field := &widget.PromptField{Label: c.T("app.password"), Required: true}
	field.Input.Password = true
	prompt := &widget.Prompt{
		Title:    c.T("app.needs_a_password", "name", name),
		Fields:   []*widget.PromptField{field},
		OK:       c.T("app.join"),
		Cancel:   c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func(values []string) {
			c.CloseModal()
			go s.joinVoice(n.Password, values[0])
		},
	}
	if n.Wrong {
		prompt.Text = c.T("app.that_one_was_not_right")
	}
	c.OpenModal(prompt)
}
