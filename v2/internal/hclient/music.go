package hclient

import (
	"context"
	"io"
	"net/http"
	"time"
)

// MusicItem is one track found by a search or a link, as the server describes it.
type MusicItem struct {
	Source     string `json:"source"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	DurationMs int64  `json:"durationMs"`
	ThumbHash  string `json:"thumbHash,omitempty"`
}

// MusicFound is what a link or some words are: the tracks they name, and the playlist a video was opened from.
type MusicFound struct {
	Kind     string      `json:"kind"`
	Playlist string      `json:"playlist"`
	Items    []MusicItem `json:"items"`
}

// MusicResolve looks up a link or some words; nothing is queued by it.
func (c *Client) MusicResolve(ctx context.Context, input string) (MusicFound, error) {
	var out MusicFound
	err := c.do(ctx, http.MethodPost, "/api/music/resolve", map[string]string{"input": input}, &out)
	return out, err
}

// MusicClock is the server's clock in milliseconds, and how long the question and the answer took.
func (r *RT) MusicClock(ctx context.Context, channelID int) (serverNow int64, rtt time.Duration, err error) {
	sent := time.Now()
	msg, err := r.Request(ctx, "music:clock", map[string]any{"channelId": channelID})
	if err != nil {
		return 0, 0, err
	}
	var m struct {
		ServerNow int64 `json:"serverNow"`
	}
	err = msg.Decode(&m)
	return m.ServerNow, time.Since(sent), err
}

// DownloadTo streams a stored file into w without holding it, with no deadline but ctx's.
func (c *Client) DownloadTo(ctx context.Context, hash string, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/api/uploads/"+hash, nil)
	if err != nil {
		return err
	}
	if c.Password != "" {
		req.Header.Set("X-Harmony-Password", c.Password)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	slow := *c.HTTP
	slow.Timeout = 0
	res, err := slow.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return &APIError{Status: res.StatusCode}
	}
	_, err = io.Copy(w, res.Body)
	return err
}
