package hclient

import (
	"context"
	"net/http"
)

// Look is how an account presents itself: its picture, banner, name font and colour, and join sound.
type Look struct {
	AvatarHash    string     `json:"avatarHash"`
	NameFont      string     `json:"nameFont"`
	NameColor     *NameStyle `json:"nameColor"`
	BannerHash    string     `json:"bannerHash"`
	BannerDim     *int       `json:"bannerDim"`
	JoinSoundHash string     `json:"joinSoundHash"`
}

// NameFonts are the ids of the fonts a name may be drawn in, the server's own list.
var NameFonts = []string{"pacifico", "press-start", "orbitron", "playfair", "bebas", "caveat", "fredoka", "cinzel", "typewriter", "marker"}

// Limits the server puts on what a profile holds.
const (
	MaxAvatarBytes      = 256 << 10
	MaxAvatarGIFBytes   = 1 << 20
	MaxBannerBytes      = 2 << 20
	MaxJoinSoundBytes   = 1 << 20
	MaxJoinSoundSeconds = 10
	NameColorStopsMin   = 2
	NameColorStopsMax   = 4
	NameColorSpeedMin   = 1
	NameColorSpeedMax   = 30
	NameColorSpeedStep  = 0.5
)

func (c *Client) setProfile(ctx context.Context, path string, body any) (User, error) {
	var out struct {
		User User `json:"user"`
	}
	err := c.do(ctx, http.MethodPost, path, body, &out)
	if err == nil {
		c.User = out.User
	}
	return out.User, err
}

// hashBody is the body that points a profile file at an upload, or clears it when the hash is empty.
func hashBody(hash string) map[string]any {
	if hash == "" {
		return map[string]any{"hash": nil}
	}
	return map[string]any{"hash": hash}
}

// SetAvatar points the profile picture at an uploaded image; an empty hash takes it away.
func (c *Client) SetAvatar(ctx context.Context, hash string) (User, error) {
	return c.setProfile(ctx, "/api/accounts/avatar", hashBody(hash))
}

func (c *Client) SetBanner(ctx context.Context, hash string) (User, error) {
	return c.setProfile(ctx, "/api/accounts/banner", hashBody(hash))
}

func (c *Client) SetJoinSound(ctx context.Context, hash string) (User, error) {
	return c.setProfile(ctx, "/api/accounts/join-sound", hashBody(hash))
}

// SetBannerDim sets how dim the banner is drawn, 0 to 100.
func (c *Client) SetBannerDim(ctx context.Context, dim int) (User, error) {
	return c.setProfile(ctx, "/api/accounts/banner-dim", map[string]int{"dim": dim})
}

// ClearBannerDim goes back to the default dimming.
func (c *Client) ClearBannerDim(ctx context.Context) (User, error) {
	return c.setProfile(ctx, "/api/accounts/banner-dim", map[string]any{"dim": nil})
}

// SetNameColor sets the colour of the display name; nil goes back to the highest role's colour.
func (c *Client) SetNameColor(ctx context.Context, style *NameStyle) (User, error) {
	return c.setProfile(ctx, "/api/accounts/name-color", map[string]*NameStyle{"nameColor": style})
}

// SetNameFont picks the font of the display name; empty goes back to the default.
func (c *Client) SetNameFont(ctx context.Context, font string) (User, error) {
	var body any = map[string]any{"font": nil}
	if font != "" {
		body = map[string]string{"font": font}
	}
	return c.setProfile(ctx, "/api/accounts/name-font", body)
}
