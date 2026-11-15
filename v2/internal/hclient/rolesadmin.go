package hclient

import (
	"context"
	"net/http"
	"strconv"
)

// RoleBody is what makes or changes a role: all of it is sent, as the server replaces what it holds.
type RoleBody struct {
	Name             string     `json:"name"`
	Color            string     `json:"color"`
	Style            *NameStyle `json:"style"`
	Admin            bool       `json:"admin"`
	Permissions      []string   `json:"permissions"`
	Assignable       []int      `json:"assignable"`
	AssignableBadges []int      `json:"assignableBadges"`
}

// Body is the role as the request that would change it to itself.
func (r Role) Body() RoleBody {
	return RoleBody{r.Name, r.Color, r.Style, r.Admin, nonNil(r.Permissions), nonNil(r.Assignable), nonNil(r.AssignableBadges)}
}

func nonNil[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

func rolePath(id int, tail string) string { return "/api/roles/" + strconv.Itoa(id) + tail }

// Roles is every role the server has, top of the hierarchy first.
func (c *Client) Roles(ctx context.Context) ([]Role, error) {
	var out struct {
		Roles []Role `json:"roles"`
	}
	err := c.do(ctx, http.MethodGet, "/api/roles", nil, &out)
	return out.Roles, err
}

// CreateRole makes a role, which goes to the bottom of the hierarchy.
func (c *Client) CreateRole(ctx context.Context, body RoleBody) (Role, error) {
	var out struct {
		Role Role `json:"role"`
	}
	err := c.do(ctx, http.MethodPost, "/api/roles", body, &out)
	return out.Role, err
}

func (c *Client) UpdateRole(ctx context.Context, id int, body RoleBody) (Role, error) {
	var out struct {
		Role Role `json:"role"`
	}
	err := c.do(ctx, http.MethodPost, rolePath(id, ""), body, &out)
	return out.Role, err
}

func (c *Client) DeleteRole(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, rolePath(id, "/delete"), map[string]any{}, nil)
}

// ReorderRoles puts the roles in this order, every id exactly once, and returns the list as the server now has it.
func (c *Client) ReorderRoles(ctx context.Context, ids []int) ([]Role, error) {
	var out struct {
		Roles []Role `json:"roles"`
	}
	err := c.do(ctx, http.MethodPost, "/api/roles/reorder", map[string]any{"ids": ids}, &out)
	return out.Roles, err
}
