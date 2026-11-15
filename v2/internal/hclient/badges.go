package hclient

import (
	"context"
	"fmt"
	"net/http"
	"slices"
)

// Badge is a small decoration with a name, shown on a profile card: an emoji or an uploaded picture.
type Badge struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Emoji       *string `json:"emoji"`
	ImageHash   *string `json:"imageHash"`
	Position    int     `json:"position"`
}

func (b Badge) EmojiText() string { return deref(b.Emoji) }

func (b Badge) Image() string { return deref(b.ImageHash) }

// SortBadges is the badges in the order the server keeps them, as a new slice.
func SortBadges(badges []Badge) []Badge {
	sorted := slices.Clone(badges)
	slices.SortStableFunc(sorted, func(a, b Badge) int { return a.Position - b.Position })
	return sorted
}

func (c *Client) Badges(ctx context.Context) ([]Badge, error) {
	var out struct {
		Badges []Badge `json:"badges"`
	}
	err := c.do(ctx, http.MethodGet, "/api/badges", nil, &out)
	return out.Badges, err
}

// BadgeInput is a badge to make or change; the picture is an emoji or the hash of an upload ("" for none).
type BadgeInput struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Emoji       string `json:"emoji"`
	ImageHash   string `json:"imageHash"`
}

func (c *Client) CreateBadge(ctx context.Context, in BadgeInput) (Badge, error) {
	var out struct {
		Badge Badge `json:"badge"`
	}
	err := c.do(ctx, http.MethodPost, "/api/badges", in, &out)
	return out.Badge, err
}

func (c *Client) UpdateBadge(ctx context.Context, id int, in BadgeInput) (Badge, error) {
	var out struct {
		Badge Badge `json:"badge"`
	}
	err := c.do(ctx, http.MethodPost, fmt.Sprintf("/api/badges/%d", id), in, &out)
	return out.Badge, err
}

func (c *Client) DeleteBadge(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/badges/%d/delete", id), map[string]any{}, nil)
}
