package hclient

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// ForumPost is a line of a forum's listing: the post, and what the server counts about its answers.
type ForumPost struct {
	Message        ChatMessage `json:"message"`
	ReplyCount     int         `json:"replyCount"`
	LastActivityAt int64       `json:"lastActivityAt"`
	MentionCount   int         `json:"mentionCount"`
}

type ForumPage struct {
	Posts []ForumPost `json:"posts"`
	More  bool        `json:"more"`
}

// PostsQuery asks for a page of a forum's posts; Sort is activity, new or replies.
type PostsQuery struct {
	Text     string
	Sort     string
	Offset   int
	Mentions bool
}

func (c *Client) Posts(ctx context.Context, channel int, q PostsQuery) (ForumPage, error) {
	v := url.Values{"sort": {q.Sort}, "offset": {strconv.Itoa(q.Offset)}}
	if q.Text != "" {
		v.Set("q", q.Text)
	}
	if q.Mentions {
		v.Set("mentions", "1")
	}
	var out ForumPage
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/channels/%d/posts?%s", channel, v.Encode()), nil, &out)
	return out, err
}

// ThreadPage reads a post's thread: a page before a message (0 for the newest), or every message from one to the newest.
func (c *Client) ThreadPage(ctx context.Context, channel, post, before, until int) (MessagePage, error) {
	path := fmt.Sprintf("/api/channels/%d/messages?thread=%d", channel, post)
	switch {
	case until > 0:
		path += "&until=" + strconv.Itoa(until)
	case before > 0:
		path += "&before=" + strconv.Itoa(before)
	}
	var out MessagePage
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// PostPin pins a post to the top of its forum, or lets it go.
func (c *Client) PostPin(ctx context.Context, id int, pinned bool) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/post-pin", id), map[string]bool{"pinned": pinned}, nil)
}

// MarkAllRead says everything in a channel has been read; a forum is read as a whole.
func (c *Client) MarkAllRead(ctx context.Context, channelID int) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/api/channels/%d/read", channelID), map[string]any{}, nil)
}

// TypingIn tells whoever can see a forum that you are writing under one of its posts, or that you stopped.
func (r *RT) TypingIn(ctx context.Context, channelID, thread int, stopped bool) {
	_, _ = r.Request(ctx, "typing", map[string]any{"scope": "channel", "id": channelID, "thread": thread, "stopped": stopped})
}
