package hclient

import (
	"context"
	"fmt"
	"net/http"
)

// SetAttachment gives one of your messages a different file.
func (c *Client) SetAttachment(ctx context.Context, id int, hash, name string) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/attachment", id), map[string]string{"hash": hash, "name": name}, nil)
}

// Notified is who a message reached.
type Notified struct {
	Everyone bool  `json:"everyone"`
	RoleIDs  []int `json:"roleIds"`
	UserIDs  []int `json:"userIds"`
	Reached  []int `json:"notified"`
}

// Notified asks who a message notified: everybody it names, one by one or through a role or @everyone, who may read its channel.
func (c *Client) Notified(ctx context.Context, id int) (Notified, error) {
	var out Notified
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/messages/%d/notified", id), nil, &out)
	return out, err
}
