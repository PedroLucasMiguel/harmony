package store

import (
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"
)

// MaxStars is how many messages one account can star; the list lives in the settings file, which is read whole.
const MaxStars = 500

var ErrTooManyStars = errors.New("too many stars")

// StarredMessage is the part of a channel message that a star keeps: a copy, so that it reads on when the message is gone.
type StarredMessage struct {
	ID              int             `json:"id"`
	ChannelID       int             `json:"channelId"`
	UserID          int             `json:"userId"`
	Nickname        string          `json:"nickname"`
	Body            string          `json:"body"`
	CreatedAt       int64           `json:"createdAt"`
	EditedAt        int64           `json:"editedAt"`
	AttachmentHash  string          `json:"attachmentHash"`
	AttachmentName  string          `json:"attachmentName"`
	AttachmentBytes int64           `json:"attachmentBytes"`
	MediaType       string          `json:"mediaType"`
	Reply           json.RawMessage `json:"reply,omitempty"`
	ThreadID        int             `json:"threadId,omitempty"`
	Title           string          `json:"title,omitempty"`
	PostTitle       string          `json:"postTitle,omitempty"`
}

// Star is one starred channel message, in the shape the Electron client keeps it.
type Star struct {
	Kind      string         `json:"kind"`
	ID        int            `json:"id"`
	SavedAt   int64          `json:"savedAt"`
	ChannelID int            `json:"channelId"`
	Message   StarredMessage `json:"message"`
}

const channelStar = "channel"

// ServerKey is the name a server's settings are kept under: its address, without a trailing slash, in lower case.
func ServerKey(serverURL string) string {
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(serverURL), "/"))
}

// StarScope names whose stars these are: one account on one server.
func StarScope(serverURL string, user int) string {
	return ServerKey(serverURL) + "#" + strconv.Itoa(user)
}

func (s *Settings) channelStars(scope string) []Star {
	return slices.DeleteFunc(slices.Clone(s.Stars[scope]), func(st Star) bool { return st.Kind != channelStar })
}

// StarList is an account's starred channel messages, the one starred last first.
func (s *Settings) StarList(scope string) []Star {
	list := s.channelStars(scope)
	slices.Reverse(list)
	slices.SortStableFunc(list, func(a, b Star) int { return int(b.SavedAt - a.SavedAt) })
	return list
}

// Starred says whether a message is starred, from a set kept up to date by AddStar and RemoveStar.
func (s *Settings) Starred(scope string, id int) bool {
	if s.starIDs == nil || s.starScope != scope {
		s.starIDs, s.starScope = map[int]bool{}, scope
		for _, st := range s.channelStars(scope) {
			s.starIDs[st.ID] = true
		}
	}
	return s.starIDs[id]
}

// AddStar keeps a message (starred again it is the newest star). It does not save the settings.
func (s *Settings) AddStar(scope string, message StarredMessage) error {
	rest := slices.DeleteFunc(slices.Clone(s.Stars[scope]), func(st Star) bool { return st.Kind == channelStar && st.ID == message.ID })
	if len(rest) >= MaxStars {
		return ErrTooManyStars
	}
	if s.Stars == nil {
		s.Stars = map[string][]Star{}
	}
	s.Stars[scope] = append(rest, Star{Kind: channelStar, ID: message.ID, SavedAt: time.Now().UnixMilli(), ChannelID: message.ChannelID, Message: message})
	s.starIDs = nil
	return nil
}

// RemoveStar lets a message go. It does not save the settings.
func (s *Settings) RemoveStar(scope string, id int) {
	rest := slices.DeleteFunc(slices.Clone(s.Stars[scope]), func(st Star) bool { return st.Kind == channelStar && st.ID == id })
	if len(rest) == 0 {
		delete(s.Stars, scope)
	} else {
		s.Stars[scope] = rest
	}
	s.starIDs = nil
}
