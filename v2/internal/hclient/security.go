package hclient

import (
	"context"
	"net/http"
)

// RecoveryItem is one of the three questions with its answer.
type RecoveryItem struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// RecoveryState is whether the account can be recovered, and the questions it asks.
type RecoveryState struct {
	Configured bool     `json:"configured"`
	Questions  []string `json:"questions"`
}

// ChangePassword sets a new password; the server ends every session of the account and hands this one a new token.
func (c *Client) ChangePassword(ctx context.Context, current, password string) error {
	var out struct {
		Token string `json:"token"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/accounts/password", map[string]string{"current": current, "password": password}, &out); err != nil {
		return err
	}
	c.Token = out.Token
	return nil
}

func (c *Client) RecoveryStatus(ctx context.Context) (RecoveryState, error) {
	var out RecoveryState
	err := c.do(ctx, http.MethodGet, "/api/accounts/recovery", nil, &out)
	return out, err
}

func (c *Client) SetRecovery(ctx context.Context, current string, items []RecoveryItem) (RecoveryState, error) {
	var out RecoveryState
	err := c.do(ctx, http.MethodPost, "/api/accounts/recovery", map[string]any{"current": current, "items": items}, &out)
	return out, err
}

func (c *Client) ClearRecovery(ctx context.Context, current string) error {
	return c.do(ctx, http.MethodPost, "/api/accounts/recovery/clear", map[string]string{"current": current}, nil)
}
