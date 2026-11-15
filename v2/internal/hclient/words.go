package hclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
)

// words are what the server's error codes mean when it sent none of its own, as the Electron client says them.
var words = map[string]string{
	"bad_password":    "Wrong server password.",
	"locked_out":      "Too many tries. Wait a while and try again.",
	"bad_credentials": "Wrong username or password.",
	"weak_password":   "Use at least 6 characters.",
	"nickname_taken":  "That nickname is already registered.",
	"login_required":  "Log in first.",
}

// text is what an error from the server says: its own words, else the code's, else the status.
func (e *APIError) text() string {
	if e.Message != "" {
		return e.Message
	}
	if w, ok := words[e.Code]; ok {
		return w
	}
	return fmt.Sprintf("Server returned %d.", e.Status)
}

// Expired says the server no longer knows the session token.
func (e *APIError) Expired() bool {
	return e.Status == http.StatusUnauthorized && e.Code == "login_required"
}

// IsExpired is whether err is the server saying the session token is no good.
func IsExpired(err error) bool {
	var api *APIError
	return errors.Is(err, ErrRejected) || errors.As(err, &api) && api.Expired()
}

// NetError is a request that never got an answer.
type NetError struct {
	URL     string
	Timeout bool
	Err     error
}

func (e *NetError) Error() string {
	if e.Timeout {
		return "The server did not respond in time."
	}
	return fmt.Sprintf("Could not reach %s. Check the server address and that Harmony is running.", e.URL)
}

func (e *NetError) Unwrap() error { return e.Err }

// unreachable turns what the transport said into words a person can act on.
func (c *Client) unreachable(err error) error {
	var network net.Error
	timeout := errors.Is(err, context.DeadlineExceeded) || errors.As(err, &network) && network.Timeout()
	if errors.Is(err, context.Canceled) {
		return err
	}
	return &NetError{URL: c.Base, Timeout: timeout, Err: err}
}
