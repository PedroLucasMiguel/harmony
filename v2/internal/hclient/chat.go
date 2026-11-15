package hclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

type Reply struct {
	ID             int    `json:"id"`
	UserID         int    `json:"userId"`
	Nickname       string `json:"nickname"`
	Body           string `json:"body"`
	MediaType      string `json:"mediaType"`
	AttachmentName string `json:"attachmentName"`
	Deleted        bool   `json:"deleted"`
}

// ChatMessage is a message in a text channel as the server sends it.
type ChatMessage struct {
	ID               int        `json:"id"`
	ChannelID        int        `json:"channelId"`
	UserID           int        `json:"userId"`
	Nickname         string     `json:"nickname"`
	Body             string     `json:"body"`
	AttachmentHash   string     `json:"attachmentHash"`
	AttachmentName   string     `json:"attachmentName"`
	AttachmentBytes  int64      `json:"attachmentBytes"`
	MediaType        string     `json:"mediaType"`
	EditedAt         int64      `json:"editedAt"`
	ReplyTo          int        `json:"replyTo"`
	Reply            *Reply     `json:"reply"`
	Poll             *Poll      `json:"poll"`
	Mentions         []int      `json:"mentions"`
	MentionsEveryone bool       `json:"mentionsEveryone"`
	MentionRoles     []int      `json:"mentionRoles"`
	CreatedAt        int64      `json:"createdAt"`
	Reactions        []Reaction `json:"reactions"`
	Pinned           bool       `json:"pinned"`
	Title            string     `json:"title"`
	ThreadID         int        `json:"threadId"`
	PostPinnedAt     int64      `json:"postPinnedAt"`
}

// Thread is the forum post a message belongs to: the post it starts or the one it answers, or 0 outside a forum.
func (m ChatMessage) Thread() int {
	if m.Title != "" {
		return m.ID
	}
	return m.ThreadID
}

type LinkPreview struct {
	URL         string `json:"url"`
	Site        string `json:"site"`
	Title       string `json:"title"`
	Description string `json:"description"`
	ImageHash   string `json:"imageHash"`
	Color       string `json:"color"`
	Kind        string `json:"kind"`
}

func (c *Client) History(ctx context.Context, channelID, before int) ([]ChatMessage, error) {
	path := fmt.Sprintf("/api/channels/%d/messages", channelID)
	if before > 0 {
		path += "?before=" + strconv.Itoa(before)
	}
	var out struct {
		Messages []ChatMessage `json:"messages"`
	}
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out.Messages, err
}

type Post struct {
	Body           string     `json:"body"`
	AttachmentHash string     `json:"attachmentHash,omitempty"`
	AttachmentName string     `json:"attachmentName,omitempty"`
	ReplyTo        int        `json:"replyTo,omitempty"`
	Poll           *PollDraft `json:"poll,omitempty"`
	Title          string     `json:"title,omitempty"`
	ThreadID       int        `json:"threadId,omitempty"`
}

func (c *Client) Send(ctx context.Context, channelID int, post Post) (ChatMessage, error) {
	var out struct {
		Message ChatMessage `json:"message"`
	}
	err := c.do(ctx, http.MethodPost, fmt.Sprintf("/api/channels/%d/messages", channelID), post, &out)
	return out.Message, err
}

func (c *Client) EditMessage(ctx context.Context, id int, body string) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/edit", id), map[string]string{"body": body}, nil)
}

func (c *Client) DeleteMessage(ctx context.Context, id int) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/delete", id), map[string]any{}, nil)
}

func (c *Client) MarkRead(ctx context.Context, channelID, upTo int) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/channels/%d/read", channelID), map[string]int{"upTo": upTo}, nil)
}

func (c *Client) LinkPreview(ctx context.Context, address string) (*LinkPreview, error) {
	var out struct {
		Preview *LinkPreview `json:"preview"`
	}
	err := c.do(ctx, http.MethodGet, "/api/link-preview?url="+url.QueryEscape(address), nil, &out)
	return out.Preview, err
}

// Download reads up to limit bytes of a stored file (all of it when limit is 0).
func (c *Client) Download(ctx context.Context, hash string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/api/uploads/"+hash, nil)
	if err != nil {
		return nil, err
	}
	if c.Password != "" {
		req.Header.Set("X-Harmony-Password", c.Password)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if limit > 0 {
		req.Header.Set("Range", "bytes=0-"+strconv.FormatInt(limit-1, 10))
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return nil, &APIError{Status: res.StatusCode}
	}
	var reader io.Reader = res.Body
	if limit > 0 {
		reader = io.LimitReader(res.Body, limit)
	}
	return io.ReadAll(reader)
}

// Upload sends a file in the server's chunks and returns the hash it is stored under.
func (c *Client) Upload(ctx context.Context, file io.ReaderAt, size int64, contentType string, progress func(sent int64)) (string, error) {
	var session struct {
		ID         string `json:"id"`
		ChunkBytes int64  `json:"chunkBytes"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/uploads/sessions", map[string]any{"size": size, "contentType": contentType}, &session); err != nil {
		return "", err
	}
	chunk := make([]byte, min(max(session.ChunkBytes, 1), size+1))
	for offset := int64(0); offset < size; {
		n, err := file.ReadAt(chunk[:min(int64(len(chunk)), size-offset)], offset)
		if n == 0 && err != nil {
			return "", err
		}
		if err := c.sendChunk(ctx, session.ID, offset, chunk[:n]); err != nil {
			c.cancelUpload(session.ID)
			return "", err
		}
		offset += int64(n)
		if progress != nil {
			progress(offset)
		}
	}
	var done struct {
		Hash string `json:"hash"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/uploads/sessions/"+session.ID+"/finish", map[string]any{}, &done); err != nil {
		return "", err
	}
	return done.Hash, nil
}

func (c *Client) sendChunk(ctx context.Context, id string, offset int64, data []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/api/uploads/sessions/%s/chunk?offset=%d", c.Base, id, offset), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	if c.Password != "" {
		req.Header.Set("X-Harmony-Password", c.Password)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		apiErr := &APIError{Status: res.StatusCode}
		_ = json.NewDecoder(res.Body).Decode(apiErr)
		return apiErr
	}
	return nil
}

func (c *Client) cancelUpload(id string) {
	_ = c.do(context.Background(), http.MethodPost, "/api/uploads/sessions/"+id+"/cancel", map[string]any{}, nil)
}

// Typing tells the server whoever can see the channel that you are writing in it, or that you stopped.
func (r *RT) Typing(ctx context.Context, channelID int, stopped bool) {
	_, _ = r.Request(ctx, "typing", map[string]any{"scope": "channel", "id": channelID, "stopped": stopped})
}
