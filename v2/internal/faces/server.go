package faces

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// ServerPicture is a store for the pictures of one server that is not signed in to: its logo (route "/api/server/logo") or
// banner ("/api/server/banner"), which only need the door password. The file of a hash is what the route answers with now,
// so a new picture, which is a new hash, is fetched when the hash changes.
func ServerPicture(base, password, route string, client *http.Client) *Store {
	base = strings.TrimRight(base, "/")
	return New(func(ctx context.Context, _ string, limit int64) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+route, nil)
		if err != nil {
			return nil, err
		}
		if password != "" {
			req.Header.Set("X-Harmony-Password", password)
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			return nil, http.ErrMissingFile
		}
		return io.ReadAll(io.LimitReader(res.Body, limit))
	})
}
