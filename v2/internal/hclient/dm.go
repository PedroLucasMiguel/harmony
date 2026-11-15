package hclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const maxSealedFile = 256 << 20

// The client's own timeout would cut a big file short, so the deadline is the caller's context.

func (c *Client) dmSend(ctx context.Context, method, path, contentType string, body io.Reader, limit int64) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return 0, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.Password != "" {
		req.Header.Set("X-Harmony-Password", c.Password)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := (&http.Client{Transport: c.HTTP.Transport}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, limit))
	return res.StatusCode, raw, err
}

// DMRequest calls a private-conversation route and returns the answer as it is, whatever its status: the caller reads
// refusals (a 409 carries the keys that changed) as well as successes. An error is only a request that got no answer.
func (c *Client) DMRequest(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	contentType := ""
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader, contentType = bytes.NewReader(raw), "application/json"
	}
	return c.dmSend(ctx, method, path, contentType, reader, 8<<20)
}

// DMUpload stores a sealed file in a conversation and answers like DMRequest.
func (c *Client) DMUpload(ctx context.Context, conversation int, sealed []byte) (int, []byte, error) {
	return c.dmSend(ctx, http.MethodPost, fmt.Sprintf("/api/dms/%d/uploads", conversation), "application/octet-stream", bytes.NewReader(sealed), 1<<20)
}

// DMDownload is a sealed file of a conversation, as stored.
func (c *Client) DMDownload(ctx context.Context, conversation int, hash string) ([]byte, error) {
	status, raw, err := c.dmSend(ctx, http.MethodGet, fmt.Sprintf("/api/dms/%d/uploads/%s", conversation, hash), "", nil, maxSealedFile)
	if err != nil {
		return nil, err
	}
	if status >= 300 {
		return nil, &APIError{Status: status}
	}
	return raw, nil
}
