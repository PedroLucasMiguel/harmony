package hclient

import (
	"context"
	"net/http"
	"strings"
)

// Error codes the recovery endpoints answer with.
const (
	CodeNoRecovery   = "no_recovery"
	CodeWrongAnswers = "wrong_answers"
	CodeLockedOut    = "locked_out"
	CodeWeakPassword = "weak_password"
	CodeResetExpired = "reset_expired"
)

// RecoveryName is how the server names an account: lower case, without spaces.
func RecoveryName(raw string) string {
	return strings.ToLower(strings.Join(strings.Fields(raw), ""))
}

// RecoveryQuestions are the three questions the person wrote for the account.
func (c *Client) RecoveryQuestions(ctx context.Context, nickname string) ([]string, error) {
	var out struct {
		Questions []string `json:"questions"`
	}
	err := c.do(ctx, http.MethodPost, "/api/accounts/recovery/start", map[string]string{"nickname": nickname}, &out)
	return out.Questions, err
}

// RecoveryVerify sends the answers and returns the token that allows one new password.
func (c *Client) RecoveryVerify(ctx context.Context, nickname string, answers []string) (string, error) {
	var out struct {
		ResetToken string `json:"resetToken"`
	}
	err := c.do(ctx, http.MethodPost, "/api/accounts/recovery/verify", map[string]any{"nickname": nickname, "answers": answers}, &out)
	return out.ResetToken, err
}

func (c *Client) RecoveryReset(ctx context.Context, resetToken, password string) error {
	return c.do(ctx, http.MethodPost, "/api/accounts/recovery/reset", map[string]string{"resetToken": resetToken, "password": password}, nil)
}
