package app

import (
	"context"
	"errors"
	"time"

	"harmony/v2/internal/hclient"
)

// The statuses a person can choose on a server, in the order the menu lists them.
var Statuses = []string{"online", "idle", "dnd", "invisible"}

// OwnStatus is what this person chose on this server; the server keeps it, so another window of theirs may have changed it.
func (s *Session) OwnStatus() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == "" {
		return "online"
	}
	return s.status
}

// SetStatus chooses what to be on this server. It shows at once and is put back when the server refuses.
func (s *Session) SetStatus(status string) error {
	was := s.OwnStatus()
	if status == was {
		return nil
	}
	s.adoptStatus(status)
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	msg, err := s.rt.Request(ctx, "presence:set", map[string]any{"status": status})
	if err == nil && msg.Type == "presence:error" {
		err = errors.New("the server did not accept the status")
	}
	if err != nil {
		s.adoptStatus(was)
	}
	return err
}

func (s *Session) adoptStatus(status string) {
	s.mu.Lock()
	s.status = status
	s.rev++
	s.mu.Unlock()
	s.changed()
}

// SetAway tells the server the app has not been touched for a while (or has been, again). The server counts every window of the person as one, and shows idle only to those who chose online.
func (s *Session) SetAway(away bool) {
	s.mu.Lock()
	if s.away == away {
		s.mu.Unlock()
		return
	}
	s.away = away
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	if _, err := s.rt.Request(ctx, "presence:away", map[string]any{"away": away}); err != nil {
		s.mu.Lock()
		s.away = !away
		s.mu.Unlock()
	}
}

// InVoice says whether this session is in a voice channel: somebody on a call is not idle.
func (s *Session) InVoice() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.joined != nil
}

func (s *Session) selfStatusEvent(msg hclient.Message) {
	var m struct {
		Status string `json:"status"`
	}
	if msg.Decode(&m) == nil {
		s.adoptStatus(m.Status)
	}
}
