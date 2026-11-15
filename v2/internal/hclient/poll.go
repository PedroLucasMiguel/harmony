package hclient

import (
	"context"
	"fmt"
	"net/http"
)

// Poll is a poll as a channel message carries it: its settings and, once the server has counted, its votes.
type Poll struct {
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Footer      string       `json:"footer"`
	Options     []string     `json:"options"`
	Multiple    bool         `json:"multiple"`
	Anonymous   bool         `json:"anonymous"`
	EndsAt      int64        `json:"endsAt"`
	Results     *PollResults `json:"results"`
}

// PollResults is what the votes add up to. Voters is empty for a poll that hides them; Mine is what this person chose.
type PollResults struct {
	Counts []int   `json:"counts"`
	Total  int     `json:"total"`
	Voters [][]int `json:"voters"`
	Mine   []int   `json:"mine"`
}

// PollDraft is a poll being sent.
type PollDraft struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Footer      string   `json:"footer"`
	Options     []string `json:"options"`
	Multiple    bool     `json:"multiple"`
	Anonymous   bool     `json:"anonymous"`
	EndsAt      int64    `json:"endsAt,omitempty"`
}

// Vote replaces what this person chose in a poll with options; an empty list takes the vote back.
func (c *Client) Vote(ctx context.Context, messageID int, options []int) (PollResults, error) {
	var out struct {
		Results PollResults `json:"results"`
	}
	if options == nil {
		options = []int{}
	}
	err := c.do(ctx, http.MethodPost, fmt.Sprintf("/api/messages/%d/vote", messageID), map[string][]int{"options": options}, &out)
	return out.Results, err
}
