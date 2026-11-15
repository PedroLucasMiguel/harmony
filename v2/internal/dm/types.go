package dm

import (
	"encoding/json"
	"fmt"
)

// KeyState says whether this computer can take part in private conversations yet.
type KeyState int

const (
	// Loading: the server is being asked what keys there are.
	Loading KeyState = iota
	// Ready: this computer has the account's key and everything works.
	Ready
	// Locked: the account has a key this computer does not; the recovery key opens it here (Unlock), or StartOver makes a new one.
	Locked
	// Failed: the server could not be asked; Status.Failure says why. Start tries again.
	Failed
	// Unsupported: the server is older than private conversations.
	Unsupported
)

// Error codes of an *Error. Besides these, the server's own codes (no_such_message, blocked, slow_down, too_long, ...)
// come through as they are.
const (
	CodeNoKey          = "no_key"
	CodePeerHasNoKey   = "peer_has_no_key"
	CodeKeyNotConfirm  = "key_not_confirmed"
	CodeTooLong        = "too_long"
	CodeEmptyMessage   = "empty_message"
	CodeNoConversation = "no_such_conversation"
	CodeNoMessage      = "no_such_message"
	CodeUnreachable    = "unreachable"
)

// MaxBody is the longest message body, in characters as the server counts them (UTF-16 units).
const MaxBody = 4000

// Error is a refusal a screen can word: Code is stable, Message is the server's own sentence when it sent one, and in a
// group User says whom it is about (whose key is in doubt, who cannot be added).
type Error struct {
	Code    string
	Message string
	User    int
	Status  int
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

func sealWords(code string) string {
	switch code {
	case CodeNoKey:
		return "Set up your private messages first."
	case CodePeerHasNoKey:
		return "They have not set up private messages yet."
	case CodeKeyNotConfirm:
		return "Their security key changed, so nothing was sent. Compare your safety number or accept the new key in the conversation first."
	}
	return code
}

// Key is somebody's public key as the server lists it.
type Key struct {
	ID        int    `json:"id"`
	UserID    int    `json:"userId"`
	PublicKey string `json:"publicKey"`
	CreatedAt int64  `json:"createdAt"`
}

// ownKey is your own key with the wrapped private half only the recovery key opens.
type ownKey struct {
	Key
	Wrapped *string `json:"wrapped"`
}

// Reply is the message a message answers, with a preview of it.
type Reply struct {
	ID             int    `json:"id"`
	User           int    `json:"userId"`
	Body           string `json:"body"`
	AttachmentName string `json:"attachmentName,omitempty"`
	Deleted        bool   `json:"deleted,omitempty"`
}

// File is the attachment of a message: its key travels inside the sealed message, and Media says how to draw it
// ("image", "video", "audio" or "file").
type File struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Mime  string `json:"mime"`
	Size  int64  `json:"size"`
	Media string `json:"-"`
}

// Reaction is one emoji and who put it on a message. Votes of a poll ("poll:N") are listed here too.
type Reaction struct {
	Emoji string
	Count int
	Users []int
}

// Kind is what a message is: a person's text, or a line the server wrote.
type Kind string

const (
	KindText  Kind = "text"
	KindCall  Kind = "call"
	KindGroup Kind = "group"
)

// Message is a message of a conversation as it is drawn. Messages are never changed once shared: an edit, a reaction
// or a trust change makes a new one, so a reader may keep a pointer.
type Message struct {
	ID           int
	Conversation int
	User         int
	Kind         Kind
	Body         string
	CreatedAt    int64
	// EditedAt is 0 for a message never edited.
	EditedAt int64
	// Rev counts the edits.
	Rev            int
	Reply          *Reply
	File           *File
	AttachmentHash string
	// Poll is the poll the message carries as the sender wrote it, for the poll screen to read.
	Poll      json.RawMessage
	Reactions []Reaction
	Pinned    bool
	// Line is what the server says about a call or group line (Kind is not text), as JSON.
	Line json.RawMessage
	// Unreadable: this computer cannot open it (not sent to a key it holds, or tampered with); OutOfPlace: it was
	// sealed to be somewhere else (the server repeated or swapped it).
	Unreadable, OutOfPlace bool
	// Unconfirmed: opened with a key of the sender's that was never accepted here.
	Unconfirmed bool
	// Layout belongs to whoever draws the message; it is not carried to the message's next version.
	Layout any

	mid string
}

// Conversation is a one-to-one conversation or a group, as shown in the list. Immutable once shared.
type Conversation struct {
	ID    int
	Group bool
	// Peer is the other person of a pair (yourself in a conversation with yourself) and 0 in a group.
	Peer    int
	Members []int
	// Title and Owner are a group's name and who runs it.
	Title     string
	Owner     int
	CreatedAt int64
	LastAt    int64
	Unread    int
	LastRead  int
	// Last is the newest message, opened, for the row; nil when the conversation is empty.
	Last *Message
}

// Trust is what this computer makes of one person's key.
type Trust struct {
	// KeyChanged: their key changed (or something opened with one nobody accepted) and the change was not accepted yet.
	KeyChanged bool
	// Verified: the safety number of their current key was compared in person.
	Verified bool
}

// Version is what a message said before an edit.
type Version struct {
	Body       string
	At         int64
	Unreadable bool
}

// Thread is a conversation's messages, oldest first. Immutable once shared.
type Thread struct {
	Messages []*Message
	// More: older messages exist on the server.
	More    bool
	Loading bool
	// Err is why the last load failed, nil otherwise.
	Err error
	// Pinned is what is pinned in the conversation, the last pinned first.
	Pinned []*Message
}

// Status is the state of private conversations for this account, for the banner and the badge.
type Status struct {
	State   KeyState
	Failure string
	// NeedsBackup: a recovery key was made here and the person has not said it is kept somewhere yet.
	NeedsBackup bool
	// Unread counts messages waiting; when this computer cannot read them (Locked) it is only the server's count.
	Unread int
}

// rawMessage is a message as the server sends it.
type rawMessage struct {
	ID             int             `json:"id"`
	Conversation   int             `json:"conversationId"`
	User           int             `json:"userId"`
	Kind           string          `json:"kind"`
	SenderKey      int             `json:"senderKey"`
	RecipientKey   int             `json:"recipientKey"`
	Sealed         string          `json:"sealed"`
	Meta           json.RawMessage `json:"meta"`
	AttachmentHash string          `json:"attachmentHash"`
	Reactions      []rawReaction   `json:"reactions"`
	CreatedAt      int64           `json:"createdAt"`
	EditedAt       int64           `json:"editedAt"`
	Pinned         bool            `json:"pinned"`
}

type rawReaction struct {
	User         int    `json:"userId"`
	SenderKey    int    `json:"senderKey"`
	RecipientKey int    `json:"recipientKey"`
	Sealed       string `json:"sealed"`
}

type rawVersion struct {
	SenderKey    int    `json:"senderKey"`
	RecipientKey int    `json:"recipientKey"`
	Sealed       string `json:"sealed"`
	At           int64  `json:"at"`
}

type rawConversation struct {
	ID        int         `json:"id"`
	Kind      string      `json:"kind"`
	UserIDs   []int       `json:"userIds"`
	Title     string      `json:"title"`
	OwnerID   int         `json:"ownerId"`
	CreatedAt int64       `json:"createdAt"`
	LastAt    int64       `json:"lastAt"`
	Unread    int         `json:"unread"`
	LastRead  int         `json:"lastReadId"`
	Last      *rawMessage `json:"last"`
}

func mediaOf(mime string) string {
	for i := 0; i < len(mime); i++ {
		if mime[i] == '/' {
			mime = mime[:i]
			break
		}
	}
	switch mime {
	case "image", "video", "audio":
		return mime
	}
	return "file"
}

func errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
