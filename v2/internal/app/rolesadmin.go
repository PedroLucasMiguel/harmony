package app

import (
	"context"

	"harmony/v2/internal/hclient"
)

func (s *Session) adoptRoles(roles []hclient.Role) {
	s.mu.Lock()
	s.roles = hclient.SortRoles(roles)
	s.rev++
	s.mu.Unlock()
	s.changed()
}

func (s *Session) reloadRoles(ctx context.Context) error {
	roles, err := s.client.Roles(ctx)
	if err == nil {
		s.adoptRoles(roles)
	}
	return err
}

// CreateRole makes a role at the bottom of the hierarchy; every client is told of it.
func (s *Session) CreateRole(ctx context.Context, body hclient.RoleBody) (hclient.Role, error) {
	role, err := s.client.CreateRole(ctx, body)
	if err != nil {
		return role, err
	}
	return role, s.reloadRoles(ctx)
}

// UpdateRole sends a role as the editor holds it and adopts the roles the server now has.
func (s *Session) UpdateRole(ctx context.Context, id int, body hclient.RoleBody) error {
	if _, err := s.client.UpdateRole(ctx, id, body); err != nil {
		return err
	}
	return s.reloadRoles(ctx)
}

func (s *Session) DeleteRole(ctx context.Context, id int) error {
	if err := s.client.DeleteRole(ctx, id); err != nil {
		return err
	}
	return s.reloadRoles(ctx)
}

// ReorderRoles puts the roles in this order, every id once.
func (s *Session) ReorderRoles(ctx context.Context, ids []int) error {
	roles, err := s.client.ReorderRoles(ctx, ids)
	if err == nil {
		s.adoptRoles(roles)
	}
	return err
}
