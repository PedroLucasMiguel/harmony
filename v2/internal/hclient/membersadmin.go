package hclient

import (
	"context"
	"net/http"
	"strconv"
)

func accountPath(id int, action string) string {
	return "/api/accounts/" + strconv.Itoa(id) + "/" + action
}

func (c *Client) accountReply(ctx context.Context, id int, action string, body any) (Account, error) {
	var out struct {
		User Account `json:"user"`
	}
	err := c.do(ctx, http.MethodPost, accountPath(id, action), body, &out)
	return out.User, err
}

// SetAccountRole makes somebody an owner, a super admin ("admin") or a member; only the owner may.
func (c *Client) SetAccountRole(ctx context.Context, id int, role string) (Account, error) {
	return c.accountReply(ctx, id, "role", map[string]string{"role": role})
}

// SetAccountRoles replaces the roles somebody holds, by id.
func (c *Client) SetAccountRoles(ctx context.Context, id int, roles []int) (Account, error) {
	if roles == nil {
		roles = []int{}
	}
	return c.accountReply(ctx, id, "roles", map[string][]int{"roles": roles})
}

// SetAccountBadges replaces the badges somebody holds, by id.
func (c *Client) SetAccountBadges(ctx context.Context, id int, badges []int) (Account, error) {
	if badges == nil {
		badges = []int{}
	}
	return c.accountReply(ctx, id, "badges", map[string][]int{"badges": badges})
}

// KickAccount signs somebody out everywhere; they may sign in again.
func (c *Client) KickAccount(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, accountPath(id, "kick"), struct{}{}, nil)
}

// BanAccount bans somebody, or with banned false lifts the ban.
func (c *Client) BanAccount(ctx context.Context, id int, banned bool) (Account, error) {
	return c.accountReply(ctx, id, "ban", map[string]bool{"banned": banned})
}

// DeleteAccount removes an account and everything written under it, and says how many messages went with it; only the owner may.
func (c *Client) DeleteAccount(ctx context.Context, id int) (int, error) {
	var out struct {
		Messages int `json:"messages"`
	}
	err := c.do(ctx, http.MethodPost, accountPath(id, "delete"), struct{}{}, &out)
	return out.Messages, err
}
