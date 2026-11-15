package hclient

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
)

// NewChannel is what makes a channel; inside a group it takes the group's password, roles and people.
type NewChannel struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Password string `json:"password,omitempty"`
	GroupID  *int   `json:"groupId,omitempty"`
	Roles    []int  `json:"roles,omitempty"`
	Users    []int  `json:"users,omitempty"`
}

// NewGroup is what makes a group heading.
type NewGroup struct {
	Name     string `json:"name"`
	Password string `json:"password,omitempty"`
	Roles    []int  `json:"roles,omitempty"`
	Users    []int  `json:"users,omitempty"`
}

// Patch is a change to a channel or a group: only what is set is sent. An empty Password takes the password off, and an empty list of Roles or Users opens it to everybody again.
type Patch struct {
	Name     *string `json:"name,omitempty"`
	Password *string `json:"password,omitempty"`
	Roles    *[]int  `json:"roles,omitempty"`
	Users    *[]int  `json:"users,omitempty"`
}

// Placement is one entry of the whole channel list as drawn: a group heading, or a channel and the group it sits in.
type Placement struct {
	Group   int
	ID      int
	GroupID *int
}

func (p Placement) MarshalJSON() ([]byte, error) {
	if p.Group != 0 {
		return json.Marshal(map[string]int{"group": p.Group})
	}
	return json.Marshal(struct {
		ID      int  `json:"id"`
		GroupID *int `json:"groupId"`
	}{p.ID, p.GroupID})
}

func channelPath(id int, tail string) string { return "/api/channels/" + strconv.Itoa(id) + tail }

func groupPath(id int, tail string) string { return "/api/channels/groups/" + strconv.Itoa(id) + tail }

func (c *Client) CreateChannel(ctx context.Context, n NewChannel) (Channel, error) {
	var out struct {
		Channel Channel `json:"channel"`
	}
	err := c.do(ctx, http.MethodPost, "/api/channels", n, &out)
	return out.Channel, err
}

func (c *Client) UpdateChannel(ctx context.Context, id int, p Patch) (Channel, error) {
	var out struct {
		Channel Channel `json:"channel"`
	}
	err := c.do(ctx, http.MethodPost, channelPath(id, ""), p, &out)
	return out.Channel, err
}

func (c *Client) DeleteChannel(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, channelPath(id, "/delete"), map[string]any{}, nil)
}

func (c *Client) CreateGroup(ctx context.Context, n NewGroup) (Group, error) {
	var out struct {
		Group Group `json:"group"`
	}
	err := c.do(ctx, http.MethodPost, "/api/channels/groups", n, &out)
	return out.Group, err
}

func (c *Client) UpdateGroup(ctx context.Context, id int, p Patch) (Group, error) {
	var out struct {
		Group Group `json:"group"`
	}
	err := c.do(ctx, http.MethodPost, groupPath(id, ""), p, &out)
	return out.Group, err
}

func (c *Client) DeleteGroup(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, groupPath(id, "/delete"), map[string]any{}, nil)
}

// Arrange writes the whole channel list in the order it is drawn; the server sends the result to everybody.
func (c *Client) Arrange(ctx context.Context, order []Placement) error {
	return c.do(ctx, http.MethodPost, "/api/channels/arrange", map[string]any{"order": order}, nil)
}
