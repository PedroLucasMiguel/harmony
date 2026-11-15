package hclient

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// SearchQuery is a search of the server's text channels; a zero field is a filter left out.
type SearchQuery struct {
	Text     string
	From     []int
	In       []int
	Mentions []int
	Has      []string
	// After and Before are milliseconds since 1970.
	After, Before int64
	// Pinned is 1 for only the pinned, -1 for only those that are not, 0 for both.
	Pinned int
	Oldest bool
	Offset int
	Limit  int
	// Thread limits the search to one forum post and what is written under it.
	Thread int
}

type SearchResult struct {
	Total   int           `json:"total"`
	Capped  bool          `json:"capped"`
	Results []ChatMessage `json:"results"`
}

func joinInts(list []int) string {
	parts := make([]string, len(list))
	for i, n := range list {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ",")
}

func (q SearchQuery) values() url.Values {
	v := url.Values{}
	set := func(key, value string) {
		if value != "" {
			v.Set(key, value)
		}
	}
	set("q", q.Text)
	set("from", joinInts(q.From))
	set("in", joinInts(q.In))
	set("mentions", joinInts(q.Mentions))
	set("has", strings.Join(q.Has, ","))
	if q.After != 0 {
		set("after", strconv.FormatInt(q.After, 10))
	}
	if q.Before != 0 {
		set("before", strconv.FormatInt(q.Before, 10))
	}
	switch q.Pinned {
	case 1:
		v.Set("pinned", "1")
	case -1:
		v.Set("pinned", "0")
	}
	if q.Oldest {
		v.Set("sort", "old")
	}
	if q.Thread != 0 {
		v.Set("thread", strconv.Itoa(q.Thread))
	}
	v.Set("offset", strconv.Itoa(q.Offset))
	if q.Limit > 0 {
		v.Set("limit", strconv.Itoa(q.Limit))
	}
	return v
}

// Search looks through every text channel the person may read.
func (c *Client) Search(ctx context.Context, q SearchQuery) (SearchResult, error) {
	var out SearchResult
	err := c.do(ctx, http.MethodGet, "/api/search?"+q.values().Encode(), nil, &out)
	return out, err
}

// MessagePage is what the server sends for a channel's log: a page of messages and the channel's pinned ones.
type MessagePage struct {
	Messages []ChatMessage `json:"messages"`
	Pinned   []ChatMessage `json:"pinned"`
	Complete bool          `json:"complete"`
	// Post is the first message of a forum post's thread, which a long thread's first page may not reach.
	Post *ChatMessage `json:"post"`
}

// Page reads the page of messages before one (0 for the newest page), or, with until, every message from that one to the newest.
func (c *Client) Page(ctx context.Context, channelID, before, until int) (MessagePage, error) {
	path := fmt.Sprintf("/api/channels/%d/messages", channelID)
	switch {
	case until > 0:
		path += "?until=" + strconv.Itoa(until)
	case before > 0:
		path += "?before=" + strconv.Itoa(before)
	}
	var out MessagePage
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// Pin pins a message in its channel, or lets it go; everybody sees it.
func (c *Client) Pin(ctx context.Context, id int, pinned bool) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/pin", id), map[string]bool{"pinned": pinned}, nil)
}
