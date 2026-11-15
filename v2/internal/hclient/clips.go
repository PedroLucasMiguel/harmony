package hclient

import (
	"context"
	"net/http"
	"strconv"
)

// Clip is a sound in the server's soundpad.
type Clip struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Emoji    string `json:"emoji"`
	Hash     string `json:"hash"`
	Uploader string `json:"uploader"`
}

func (c *Client) Clips(ctx context.Context) ([]Clip, error) {
	var out struct {
		Clips []Clip `json:"clips"`
	}
	err := c.do(ctx, http.MethodGet, "/api/soundpad", nil, &out)
	return out.Clips, err
}

// AddClip makes a soundpad clip out of a file that was already uploaded.
func (c *Client) AddClip(ctx context.Context, name, emoji, hash string) error {
	return c.do(ctx, http.MethodPost, "/api/soundpad", map[string]string{"name": name, "emoji": emoji, "hash": hash}, nil)
}

// RenameClip changes a clip's name and emoji; the audio is untouched.
func (c *Client) RenameClip(ctx context.Context, id int, name, emoji string) error {
	return c.do(ctx, http.MethodPost, "/api/soundpad/"+strconv.Itoa(id)+"/rename", map[string]string{"name": name, "emoji": emoji}, nil)
}

func (c *Client) DeleteClip(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, "/api/soundpad/"+strconv.Itoa(id)+"/delete", nil, nil)
}

// ReorderClips sends every clip id once, in the order the soundpad should have.
func (c *Client) ReorderClips(ctx context.Context, ids []int) error {
	return c.do(ctx, http.MethodPost, "/api/soundpad/reorder", map[string][]int{"ids": ids}, nil)
}
