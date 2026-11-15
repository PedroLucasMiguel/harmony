// Package hclient speaks the Harmony server's HTTP API and realtime WebSocket.
package hclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	Base     string
	Password string
	Token    string
	User     User
	// Relogin, when set, is asked for a new session token when the server stops accepting this one; it says whether Token is new.
	Relogin func(ctx context.Context) bool

	HTTP *http.Client
}

type User struct {
	ID          int    `json:"id"`
	Nickname    string `json:"nickname"`
	DisplayName string `json:"displayName"`
	CustomName  bool   `json:"customName"`
	Role        string `json:"role"`
	Roles       []int  `json:"roles"`
	Look
}

type Health struct {
	OK               bool   `json:"ok"`
	Name             string `json:"name"`
	PasswordRequired bool   `json:"passwordRequired"`
	Authenticated    bool   `json:"authenticated"`
	SignalingBase    string `json:"signalingBase"`
	HasAccounts      bool   `json:"hasAccounts"`
	MediaMTX         string `json:"mediamtx"`
	NeedsOwner       bool   `json:"needsOwner"`
	// Logo and Banner are the hashes of the server's own pictures, empty when it has none.
	Logo   string `json:"logo"`
	Banner string `json:"banner"`
}

type APIError struct {
	Status  int
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *APIError) Error() string { return e.text() }

func New(base, password string, insecure bool) *Client {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if !strings.Contains(base, "://") {
		base = "http://" + base
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if insecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
	}
	return &Client{Base: base, Password: password, HTTP: &http.Client{Transport: transport, Timeout: 20 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Password != "" {
		req.Header.Set("X-Harmony-Password", c.Password)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return c.unreachable(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode >= 300 {
		apiErr := &APIError{Status: res.StatusCode}
		_ = json.Unmarshal(raw, apiErr)
		return apiErr
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (c *Client) Health(ctx context.Context) (Health, error) {
	var h Health
	err := c.do(ctx, http.MethodGet, "/api/health", nil, &h)
	return h, err
}

func (c *Client) Login(ctx context.Context, nickname, password string) error {
	var out struct {
		User  User   `json:"user"`
		Token string `json:"token"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/accounts/login", map[string]string{"nickname": nickname, "password": password}, &out); err != nil {
		return err
	}
	c.Token, c.User = out.Token, out.User
	return nil
}

// Me is the account the session token belongs to; a token the server no longer knows answers with an error IsExpired recognises.
func (c *Client) Me(ctx context.Context) (User, error) {
	var out struct {
		User User `json:"user"`
	}
	err := c.do(ctx, http.MethodGet, "/api/accounts/me", nil, &out)
	if err == nil {
		c.User = out.User
	}
	return out.User, err
}

// Logout ends the session on the server, so the token cannot be used again.
func (c *Client) Logout(ctx context.Context) error {
	err := c.do(ctx, http.MethodPost, "/api/accounts/logout", map[string]any{}, nil)
	c.Token = ""
	return err
}

// SetDisplayName changes the name shown for this account; empty goes back to the username.
func (c *Client) SetDisplayName(ctx context.Context, name string) (User, error) {
	var out struct {
		User User `json:"user"`
	}
	err := c.do(ctx, http.MethodPost, "/api/accounts/display-name", map[string]string{"displayName": name}, &out)
	if err == nil {
		c.User = out.User
	}
	return out.User, err
}

func (c *Client) Register(ctx context.Context, nickname, password, ownerKey string) error {
	body := map[string]string{"nickname": nickname, "password": password}
	if ownerKey != "" {
		body["ownerKey"] = ownerKey
	}
	var out struct {
		User  User   `json:"user"`
		Token string `json:"token"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/accounts/register", body, &out); err != nil {
		return err
	}
	c.Token, c.User = out.Token, out.User
	return nil
}

type ICEServer struct {
	URLs       []string
	Username   string
	Credential string
}

func (c *Client) ICEServers(ctx context.Context) ([]ICEServer, error) {
	var out struct {
		IceServers []struct {
			URLs       json.RawMessage `json:"urls"`
			Username   string          `json:"username"`
			Credential string          `json:"credential"`
		} `json:"iceServers"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/streams", nil, &out); err != nil {
		return nil, err
	}
	var servers []ICEServer
	for _, s := range out.IceServers {
		var urls []string
		if err := json.Unmarshal(s.URLs, &urls); err != nil {
			var one string
			if json.Unmarshal(s.URLs, &one) == nil {
				urls = []string{one}
			}
		}
		servers = append(servers, ICEServer{URLs: urls, Username: s.Username, Credential: s.Credential})
	}
	return servers, nil
}

// WithoutSTUN drops the STUN servers: a connection that is always to the media server gains nothing from them, and they can stall gathering.
func WithoutSTUN(servers []ICEServer) []ICEServer {
	var kept []ICEServer
	for _, s := range servers {
		var urls []string
		for _, u := range s.URLs {
			if !strings.HasPrefix(u, "stun:") && !strings.HasPrefix(u, "stuns:") {
				urls = append(urls, u)
			}
		}
		if len(urls) > 0 {
			kept = append(kept, ICEServer{URLs: urls, Username: s.Username, Credential: s.Credential})
		}
	}
	return kept
}

// Account is somebody with an account on the server.
type Account struct {
	ID          int    `json:"id"`
	Nickname    string `json:"nickname"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Roles       []int  `json:"roles"`
	Badges      []int  `json:"badges"`
	Banned      bool   `json:"banned"`
	CreatedAt   int64  `json:"createdAt"`
	Look
}

func (a Account) Name() string {
	if a.DisplayName != "" {
		return a.DisplayName
	}
	return a.Nickname
}

func (c *Client) Accounts(ctx context.Context) ([]Account, error) {
	var out struct {
		Users []Account `json:"users"`
	}
	err := c.do(ctx, http.MethodGet, "/api/accounts", nil, &out)
	return out.Users, err
}

func (c *Client) WebSocketURL() (string, error) {
	u, err := url.Parse(c.Base)
	if err != nil {
		return "", err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/ws"
	return u.String(), nil
}
