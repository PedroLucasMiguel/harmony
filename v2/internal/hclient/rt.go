package hclient

import (
	"context"
	"encoding/json"
	"fmt"
)

type Message struct {
	Type string          `json:"type"`
	Rid  int             `json:"rid,omitempty"`
	Raw  json.RawMessage `json:"-"`
}

func (m Message) Decode(v any) error { return json.Unmarshal(m.Raw, v) }

type Channel struct {
	ID       int    `json:"id"`
	Kind     string `json:"kind"` // text | voice | forum
	Name     string `json:"name"`
	Position int    `json:"position"`
	GroupID  *int   `json:"groupId"`
	Locked   bool   `json:"locked"`
	Roles    []int  `json:"roles"`
	Users    []int  `json:"users"`
}

type Member struct {
	Mid        int      `json:"mid"`
	UserID     int      `json:"userId"`
	Nickname   string   `json:"nickname"`
	Muted      bool     `json:"muted"`
	Deafened   bool     `json:"deafened"`
	ForceMuted bool     `json:"forceMuted"`
	Publishing []string `json:"publishing"` // v voice, c camera, s screen
}

func (m Member) Publishes(kind string) bool {
	for _, k := range m.Publishing {
		if k == kind {
			return true
		}
	}
	return false
}

type Hello struct {
	User     User             `json:"user"`
	Channels []Channel        `json:"channels"`
	Groups   []Group          `json:"groups"`
	Unread   []ReadMark       `json:"unread"`
	Rosters  map[int][]Member `json:"rosters"`
	Roles    []Role           `json:"roles"`
	Status   string           `json:"status"`
	Badges   []Badge          `json:"badges"`
	// VoiceCap is how many people a voice channel holds at most.
	VoiceCap int `json:"voiceCap"`
	Presence
}

// Presence says who is on the server: everybody but the invisible, and which of them are idle or not to be disturbed.
type Presence struct {
	Online   []int          `json:"online"`
	Statuses map[int]string `json:"statuses"`
}

type Joined struct {
	ChannelID int `json:"channelId"`
	Mid       int `json:"mid"`
	Tokens
	Roster []Member `json:"roster"`
	// Music is the channel's music snapshot, or null when there is none.
	Music json.RawMessage `json:"music"`
}

type Tokens struct {
	Token   string `json:"token"`
	Publish struct {
		Voice  string `json:"voice"`
		Cam    string `json:"cam"`
		Screen string `json:"screen"`
	} `json:"publish"`
	WhepBase    string `json:"whepBase"`
	ExpiresInMs int    `json:"expiresInMs"`
}

func (t Tokens) PeerURL(channelID, mid int, kind string) string {
	return fmt.Sprintf("%s/vc-%s-%s-%s/whep?token=%s", t.WhepBase, base36(channelID), base36(mid), kind, urlEscape(t.Token))
}

func (r *RT) Join(ctx context.Context, channelID int, password string) (Joined, error) {
	var j Joined
	fields := map[string]any{"channelId": channelID}
	if password != "" {
		fields["password"] = password
	}
	msg, err := r.Request(ctx, "voice:join", fields)
	if err != nil {
		return j, err
	}
	return j, msg.Decode(&j)
}

func (r *RT) Leave(ctx context.Context, channelID int) error {
	_, err := r.Request(ctx, "voice:leave", map[string]any{"channelId": channelID})
	return err
}

func (r *RT) Mute(ctx context.Context, channelID int, muted, deafened bool) error {
	_, err := r.Request(ctx, "voice:mute", map[string]any{"channelId": channelID, "muted": muted, "deafened": deafened})
	return err
}

func (r *RT) Publishing(ctx context.Context, channelID int, kind string, on bool) error {
	_, err := r.Request(ctx, "voice:publishing", map[string]any{"channelId": channelID, "kind": kind, "on": on})
	return err
}

func (r *RT) Refresh(ctx context.Context, channelID int) (Tokens, error) {
	var t Tokens
	msg, err := r.Request(ctx, "voice:refresh", map[string]any{"channelId": channelID})
	if err != nil {
		return t, err
	}
	return t, msg.Decode(&t)
}
