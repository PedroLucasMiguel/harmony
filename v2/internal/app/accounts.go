package app

import (
	"context"

	"harmony/v2/internal/hclient"
)

// accountsEvent keeps the roster current: "accounts" is the whole list again, "user:updated" one account changed.
func (s *Session) accountsEvent(msg hclient.Message) {
	switch msg.Type {
	case "accounts":
		var m struct {
			Users []hclient.Account `json:"users"`
		}
		if msg.Decode(&m) != nil {
			return
		}
		s.mu.Lock()
		s.members = m.Users
		s.rev++
		s.mu.Unlock()
	default:
		var m struct {
			User hclient.Account `json:"user"`
		}
		if msg.Decode(&m) != nil {
			return
		}
		s.adoptAccount(m.User)
		return
	}
	s.changed()
}

// adoptAccount puts one account, as the server says it is now, into the roster.
func (s *Session) adoptAccount(a hclient.Account) {
	if a.ID == 0 {
		return
	}
	s.mu.Lock()
	a = s.holdDim(a)
	next := make([]hclient.Account, len(s.members), len(s.members)+1)
	copy(next, s.members)
	replaced := false
	for i := range next {
		if next[i].ID == a.ID {
			next[i], replaced = a, true
		}
	}
	if !replaced {
		next = append(next, a)
	}
	s.members = next
	if a.ID == s.me.ID {
		s.me.Role, s.me.Roles, s.me.Look = a.Role, a.Roles, a.Look
	}
	s.rev++
	s.mu.Unlock()
	s.changed()
}

// SetAccountRole makes an account an owner, a super admin ("admin") or a member.
func (s *Session) SetAccountRole(ctx context.Context, id int, role string) error {
	a, err := s.client.SetAccountRole(ctx, id, role)
	if err == nil {
		s.adoptAccount(a)
	}
	return err
}

// SetAccountRoles replaces the roles an account holds.
func (s *Session) SetAccountRoles(ctx context.Context, id int, roles []int) error {
	a, err := s.client.SetAccountRoles(ctx, id, roles)
	if err == nil {
		s.adoptAccount(a)
	}
	return err
}

// SetAccountBadges replaces the badges an account holds.
func (s *Session) SetAccountBadges(ctx context.Context, id int, badges []int) error {
	a, err := s.client.SetAccountBadges(ctx, id, badges)
	if err == nil {
		s.adoptAccount(a)
	}
	return err
}

// BanAccount bans an account, or lifts its ban.
func (s *Session) BanAccount(ctx context.Context, id int, banned bool) error {
	a, err := s.client.BanAccount(ctx, id, banned)
	if err == nil {
		s.adoptAccount(a)
	}
	return err
}

// DeleteAccount removes an account and what it wrote; the server tells everyone, and the count of messages that went is returned.
func (s *Session) DeleteAccount(ctx context.Context, id int) (int, error) {
	return s.client.DeleteAccount(ctx, id)
}
