package hclient

import (
	"context"
	"fmt"
	"net/http"
)

// Reaction is one emoji on a message, with everybody who chose it. The emoji is a character, or :name: for a custom one.
type Reaction struct {
	Emoji   string `json:"emoji"`
	Count   int    `json:"count"`
	UserIDs []int  `json:"userIds"`
}

// Mine says whether the person has chosen this reaction.
func (r Reaction) Mine(user int) bool {
	for _, id := range r.UserIDs {
		if id == user {
			return true
		}
	}
	return false
}

// CustomEmoji is a picture the server's members added; it is typed as :name: and stored under hash like any upload.
type CustomEmoji struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Hash       string `json:"hash"`
	UploadedBy int    `json:"uploadedBy"`
	Uploader   string `json:"uploader"`
}

// React puts the person's reaction on a message, or takes it back.
func (c *Client) React(ctx context.Context, messageID int, emoji string, on bool) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/react", messageID), map[string]any{"emoji": emoji, "on": on}, nil)
}

func (c *Client) Emojis(ctx context.Context) ([]CustomEmoji, error) {
	var out struct {
		Emojis []CustomEmoji `json:"emojis"`
	}
	err := c.do(ctx, http.MethodGet, "/api/emojis", nil, &out)
	return out.Emojis, err
}

func (c *Client) AddEmoji(ctx context.Context, name, hash string) error {
	return c.do(ctx, http.MethodPost, "/api/emojis", map[string]string{"name": name, "hash": hash}, nil)
}

func (c *Client) DeleteEmoji(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/emojis/%d/delete", id), map[string]any{}, nil)
}
