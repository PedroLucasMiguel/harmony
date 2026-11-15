package app

import (
	"context"
	"time"

	"harmony/v2/internal/hclient"
)

const adminTimeout = 20 * time.Second

// adminEvent keeps what the server dialog shows current: the server's own settings, the roles and the badges.
func (s *Session) adminEvent(msg hclient.Message) {
	s.mu.Lock()
	switch msg.Type {
	case "roles":
		var m struct {
			Roles []hclient.Role `json:"roles"`
		}
		if msg.Decode(&m) != nil {
			s.mu.Unlock()
			return
		}
		s.roles = hclient.SortRoles(m.Roles)
	case "badges":
		var m struct {
			Badges []hclient.Badge `json:"badges"`
		}
		if msg.Decode(&m) != nil {
			s.mu.Unlock()
			return
		}
		s.badges = hclient.SortBadges(m.Badges)
	default:
		var m struct {
			Info   *hclient.ServerInfo `json:"info"`
			Server *hclient.ServerInfo `json:"server"`
		}
		if msg.Decode(&m) != nil {
			s.mu.Unlock()
			return
		}
		info := m.Info
		if info == nil {
			info = m.Server
		}
		if info == nil {
			s.mu.Unlock()
			return
		}
		s.server = *info
		s.name = info.Name
	}
	s.rev++
	s.mu.Unlock()
	s.changed()
}

// loadServer reads the server's settings once the session is up; a failure leaves them as the name alone.
func (s *Session) loadServer(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	if info, err := s.client.Server(ctx); err == nil {
		s.mu.Lock()
		s.server = info
		s.rev++
		s.mu.Unlock()
		s.changed()
	}
}

// SetServer sends a change to the server's settings and returns what the server now says; every client is pushed the same.
func (s *Session) SetServer(ctx context.Context, patch map[string]any) (hclient.ServerInfo, error) {
	info, err := s.client.SetServer(ctx, patch)
	if err != nil {
		return info, err
	}
	s.mu.Lock()
	s.server = info
	s.name = info.Name
	s.rev++
	s.mu.Unlock()
	s.changed()
	return info, nil
}
