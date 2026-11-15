package hclient

import (
	"context"
	"net/http"
)

// ServerInfo is what the server says about itself: its name and pictures, whether it has a door password, its upload limits.
type ServerInfo struct {
	Name             string  `json:"name"`
	Logo             *string `json:"logo"`
	Banner           *string `json:"banner"`
	PasswordRequired bool    `json:"passwordRequired"`
	RestartRequired  bool    `json:"restartRequired"`
	MusicEnabled     bool    `json:"musicEnabled"`
	MusicAvailable   *bool   `json:"musicAvailable"`
	MaxFileBytes     int64   `json:"maxFileBytes"`
	StorageBytes     int64   `json:"storageBytes"`
	UsedBytes        int64   `json:"usedBytes"`
	DiskFreeBytes    *int64  `json:"diskFreeBytes"`
	MaxFileLimit     int64   `json:"maxFileLimit"`
}

// LogoHash is the hash of the logo, or empty for none.
func (i ServerInfo) LogoHash() string { return deref(i.Logo) }

// BannerHash is the hash of the banner, or empty for none.
func (i ServerInfo) BannerHash() string { return deref(i.Banner) }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (c *Client) Server(ctx context.Context) (ServerInfo, error) {
	var out struct {
		Server ServerInfo `json:"server"`
	}
	err := c.do(ctx, http.MethodGet, "/api/server", nil, &out)
	return out.Server, err
}

// SetServer changes what the owner may: name, logo and banner (an uploaded hash, or nil for none), password ("" takes the door off),
// musicEnabled, maxFileBytes and storageBytes (nil for the default). Only the keys present are touched.
func (c *Client) SetServer(ctx context.Context, patch map[string]any) (ServerInfo, error) {
	var out struct {
		Server ServerInfo `json:"server"`
	}
	err := c.do(ctx, http.MethodPost, "/api/server", patch, &out)
	return out.Server, err
}
