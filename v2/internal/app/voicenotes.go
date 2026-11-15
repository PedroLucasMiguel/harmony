package app

import (
	"errors"
	"strconv"
	"sync"

	"harmony/v2/internal/hclient"
)

// VoiceNote is something the person has to be told about the voice room, or asked: Key is a translation key and Vars its
// name and value pairs; Password, when not zero, is a channel that wants its password, and Wrong says the last one was refused.
type VoiceNote struct {
	Key      string
	Vars     []string
	Password int
	Wrong    bool
}

type voiceNotes struct {
	mu      sync.Mutex
	pending []VoiceNote
}

func (s *Session) note(n VoiceNote) {
	s.voiceNotes.mu.Lock()
	s.voiceNotes.pending = append(s.voiceNotes.pending, n)
	s.voiceNotes.mu.Unlock()
	s.changed()
}

// TakeVoiceNotes hands over what happened to the voice room since it was last asked, in order, appended to into.
func (s *Session) TakeVoiceNotes(into []VoiceNote) []VoiceNote {
	s.voiceNotes.mu.Lock()
	defer s.voiceNotes.mu.Unlock()
	into = append(into, s.voiceNotes.pending...)
	s.voiceNotes.pending = s.voiceNotes.pending[:0]
	return into
}

// Join goes into a voice channel, leaving the one the person is in; what goes wrong is also left as a VoiceNote.
func (s *Session) Join(channelID int) error { return s.JoinWith(channelID, "") }

// JoinWith is Join with the password a locked channel asked for.
func (s *Session) JoinWith(channelID int, password string) error {
	err := s.joinWith(channelID, password)
	if err != nil {
		s.joinFailed(channelID, err)
	} else if password != "" {
		s.mu.Lock()
		if s.unlocked == nil {
			s.unlocked = map[int]bool{}
		}
		s.unlocked[channelID] = true
		s.mu.Unlock()
	}
	return err
}

// Unlocked is whether a locked channel has been opened with its password by this person since signing in.
func (s *Session) Unlocked(channelID int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unlocked[channelID]
}

func (s *Session) channelName(id int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.channels {
		if c.ID == id {
			return c.Name
		}
	}
	return ""
}

func (s *Session) joinFailed(channelID int, err error) {
	name := s.channelName(channelID)
	var reply *hclient.ReplyError
	if !errors.As(err, &reply) {
		s.note(VoiceNote{Key: "app.could_not_join", Vars: []string{"error", err.Error()}})
		return
	}
	switch reply.Code {
	case hclient.CodePasswordRequired, hclient.CodeBadPassword:
		s.note(VoiceNote{Password: channelID, Wrong: reply.Code == hclient.CodeBadPassword})
	case hclient.CodeChannelFull:
		limit := reply.Cap
		if limit == 0 {
			limit = s.VoiceCap()
		}
		s.note(VoiceNote{Key: "app.is_full_people", Vars: []string{"name", name, "cap", strconv.Itoa(limit)}})
	default:
		s.note(VoiceNote{Key: "app.could_not_join", Vars: []string{"error", reply.Code}})
	}
}

// movedEvent is an admin sending this person to another voice channel, or out of voice when to is nil.
func (s *Session) movedEvent(to *int, by string) {
	s.mu.Lock()
	in := s.joined != nil
	s.mu.Unlock()
	if !in {
		return
	}
	if to == nil {
		s.logf("removed from the voice channel by %s", by)
		s.leaveLocal()
		s.stopAudio()
		s.note(VoiceNote{Key: "app.disconnected_you", Vars: []string{"by", by}})
		return
	}
	name := s.channelName(*to)
	if name == "" {
		return
	}
	s.logf("moved to channel %d by %s", *to, by)
	s.note(VoiceNote{Key: "app.moved_you_to", Vars: []string{"by", by, "name", name}})
	go func() { _ = s.Join(*to) }()
}

// forceMuteNote tells the person when an admin has just muted them: the roster is the only thing that says so.
func (s *Session) forceMuteNote(before, after []hclient.Member, mid int) {
	forced := func(roster []hclient.Member) bool {
		for _, m := range roster {
			if m.Mid == mid {
				return m.ForceMuted
			}
		}
		return false
	}
	if forced(after) && !forced(before) {
		s.note(VoiceNote{Key: "app.an_admin_muted_your_microphone"})
	}
}

// ErrNotInVoice is what something that needs a voice room says when there is none.
var ErrNotInVoice = errors.New("join a voice channel first")
