package dm

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// Attachment is a file to send: it is sealed here, under a key of its own, before it leaves.
type Attachment struct {
	Name string
	Mime string
	Data []byte
}

// Outgoing is a message to send.
type Outgoing struct {
	Body  string
	File  *Attachment
	Reply *Message
	// Poll is a poll as the poll screen built it (JSON); Body must then say its question and options as words.
	Poll json.RawMessage
}

// body is what the server's own limit counts: UTF-16 units, as a channel's.
func bodyLength(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r >= utf8.RuneSelf && r > 0xFFFF {
			n++
		}
	}
	return n
}

// sealRequest builds the request body that seals something for a conversation as it is now (under the lock).
type sealRequest func(c *Conversation) (map[string]any, error)

func sealedBody(c *Conversation, pair func() (sealed, error), group func() (groupSealed, error)) (map[string]any, error) {
	if c.Group {
		g, err := group()
		if err != nil {
			return nil, err
		}
		return map[string]any{"copies": g.copies, "senderKey": g.senderKey}, nil
	}
	p, err := pair()
	if err != nil {
		return nil, err
	}
	return map[string]any{"sealed": p.text, "senderKey": p.senderKey, "recipientKey": p.recipientKey}, nil
}

// post seals and sends, and once more if the server says a key has changed since: the keys it names come with the
// refusal, so the next try is to the right ones. A group has two things that can move under it, somebody's key and who is
// in it, so it is tried a third time. It answers the body of a success.
func (s *Session) post(ctx context.Context, conversation int, path string, want int, build sealRequest) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		retries := 1
		s.mu.Lock()
		c := s.convs[conversation]
		if c != nil && c.Group {
			retries = 2
		}
		var body map[string]any
		var err error
		if c == nil {
			err = &Error{Code: CodeNoConversation, Message: "No such conversation."}
		} else {
			body, err = build(c)
		}
		s.mu.Unlock()
		if err != nil {
			if e, ok := err.(*Error); ok && e.Message == "" {
				e.Message = sealWords(e.Code)
			}
			return nil, err
		}
		status, raw, err := s.request(ctx, "POST", path, body)
		if err != nil {
			return nil, err
		}
		if status == want {
			return raw, nil
		}
		var stale struct {
			Error   string `json:"error"`
			Keys    []Key  `json:"keys"`
			Members []int  `json:"members"`
		}
		_ = json.Unmarshal(raw, &stale)
		if status == 409 && (stale.Error == "stale_key" || stale.Error == "stale_members") && attempt < retries {
			s.mutate(func() {
				for _, k := range stale.Keys {
					s.v.keyChanged(k)
				}
				if cur := s.convs[conversation]; cur != nil && cur.Group && stale.Members != nil {
					cp := *cur
					cp.Members = stale.Members
					s.convs[conversation] = &cp
				}
			})
			continue
		}
		return nil, refusal(status, raw)
	}
}

func (s *Session) sealMessageRequest(p payload, extra map[string]any) sealRequest {
	return func(c *Conversation) (map[string]any, error) {
		body, err := sealedBody(c,
			func() (sealed, error) { return s.v.sealMessage(c.ID, c.Peer, p) },
			func() (groupSealed, error) { return s.v.sealGroupMessage(c.ID, c.Members, p) })
		if err != nil {
			return nil, err
		}
		for k, v := range extra {
			body[k] = v
		}
		return body, err
	}
}

// Send seals and sends a message and returns its id. It shows in the conversation at once; the server's echo finds it
// already there.
func (s *Session) Send(ctx context.Context, conversation int, out Outgoing) (int, error) {
	if s.Conversation(conversation) == nil {
		return 0, &Error{Code: CodeNoConversation, Message: "No such conversation."}
	}
	if bodyLength(out.Body) > MaxBody {
		return 0, errorf(CodeTooLong, "Messages are limited to %d characters.", MaxBody)
	}
	if strings.TrimSpace(out.Body) == "" && out.File == nil {
		return 0, &Error{Code: CodeEmptyMessage, Message: "There is nothing to send."}
	}
	p := payload{Body: out.Body, Poll: out.Poll}
	hash := any(nil)
	if out.File != nil {
		sealedFile, key := sealFile(out.File.Data)
		upload, cancel := context.WithTimeout(ctx, fileTimeout)
		status, raw, err := s.api.DMUpload(upload, conversation, sealedFile)
		cancel()
		if err != nil {
			return 0, &Error{Code: CodeUnreachable, Message: "Could not reach the server."}
		}
		var done struct {
			Hash string `json:"hash"`
		}
		if status != 201 {
			return 0, refusal(status, raw)
		}
		if err := unmarshal(raw, &done); err != nil {
			return 0, err
		}
		mime := out.File.Mime
		if mime == "" {
			mime = "application/octet-stream"
		}
		p.File = &File{Key: b64(key), Name: out.File.Name, Mime: mime, Size: int64(len(out.File.Data))}
		hash = done.Hash
	}
	if r := out.Reply; r != nil {
		p.Reply = &Reply{ID: r.ID, User: r.User, Body: Preview(r)}
		if r.File != nil {
			p.Reply.AttachmentName = r.File.Name
		}
	}
	raw, err := s.post(ctx, conversation, fmt.Sprintf("/api/dms/%d/messages", conversation), 201, s.sealMessageRequest(p, map[string]any{"attachmentHash": hash}))
	if err != nil {
		return 0, err
	}
	return s.takeMessage(raw, conversation)
}

// takeMessage shows a message the server answered a send with.
func (s *Session) takeMessage(raw []byte, conversation int) (int, error) {
	var out struct {
		Message *rawMessage `json:"message"`
	}
	if err := unmarshal(raw, &out); err != nil || out.Message == nil {
		return 0, err
	}
	s.know(context.Background(), nil, keyIDs([]*rawMessage{out.Message}, nil))
	s.mutate(func() {
		if c := s.convs[conversation]; c != nil {
			s.addLocked(out.Message, c)
		}
	})
	return out.Message.ID, nil
}

func (s *Session) held(id int) (*Message, *Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, c := s.findLocked(id)
	if m == nil || c == nil {
		return nil, nil, &Error{Code: CodeNoMessage, Message: "No such message."}
	}
	return m, c, nil
}

// Edit changes the words of your own message; its file and its reply stay as they were.
func (s *Session) Edit(ctx context.Context, messageID int, body string) error {
	m, c, err := s.held(messageID)
	if err != nil {
		return err
	}
	if len(m.Poll) > 0 {
		return &Error{Code: "poll_not_editable", Message: "A poll cannot be edited."}
	}
	if bodyLength(body) > MaxBody {
		return errorf(CodeTooLong, "Messages are limited to %d characters.", MaxBody)
	}
	of := m.ID
	p := payload{Body: body, File: m.File, Reply: m.Reply, Mid: m.mid, Rev: m.Rev + 1, Of: &of}
	raw, err := s.post(ctx, c.ID, fmt.Sprintf("/api/dm-messages/%d/edit", messageID), 200, s.sealMessageRequest(p, nil))
	if err != nil {
		return err
	}
	return s.takeUpdate(raw)
}

func (s *Session) takeUpdate(raw []byte) error {
	var out struct {
		Message *rawMessage `json:"message"`
	}
	if err := unmarshal(raw, &out); err != nil || out.Message == nil {
		return err
	}
	s.know(context.Background(), nil, keyIDs([]*rawMessage{out.Message}, nil))
	s.mutate(func() { s.updateLocked(out.Message) })
	return nil
}

func (s *Session) updateLocked(raw *rawMessage) {
	s.raw[raw.ID] = raw
	s.refreshLocked(raw.ID)
	s.heldLocked()
}

// Remove deletes your own message for everybody.
func (s *Session) Remove(ctx context.Context, messageID int) error {
	if err := s.call(ctx, "POST", fmt.Sprintf("/api/dm-messages/%d/delete", messageID), map[string]any{}, 200, nil); err != nil {
		return err
	}
	s.dropMessage(messageID)
	return nil
}

func (s *Session) dropMessage(id int) {
	var lastGone bool
	s.mutate(func() { lastGone = s.dropLocked(id) })
	if lastGone {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
			defer cancel()
			_ = s.Refresh(ctx)
		}()
	}
}

// Pin pins a message of the conversation or unpins it; either person may, and both are told.
func (s *Session) Pin(ctx context.Context, messageID int, on bool) error {
	status, raw, err := s.request(ctx, "POST", fmt.Sprintf("/api/dm-messages/%d/pin", messageID), map[string]bool{"pinned": on})
	if err != nil {
		return err
	}
	if status != 200 {
		return refusal(status, raw)
	}
	return s.takeUpdate(raw)
}

// History is what a message said before each edit, oldest first.
func (s *Session) History(ctx context.Context, messageID int) ([]Version, error) {
	m, c, err := s.held(messageID)
	if err != nil {
		return nil, err
	}
	var out struct {
		Versions []rawVersion `json:"versions"`
	}
	if err := s.call(ctx, "GET", fmt.Sprintf("/api/dm-messages/%d/edits", messageID), nil, 200, &out); err != nil {
		return nil, err
	}
	var ids []int
	for _, v := range out.Versions {
		ids = append(ids, v.SenderKey, v.RecipientKey)
	}
	s.know(ctx, nil, ids)
	s.mu.Lock()
	defer s.mu.Unlock()
	versions := make([]Version, len(out.Versions))
	for i, v := range out.Versions {
		body, ok := s.v.openVersion(m, c.Peer, v)
		versions[i] = Version{Body: body, At: v.At, Unreadable: !ok}
	}
	return versions, nil
}

// React puts an emoji on a message or takes yours off; one sealed blob holds all of a person's reactions to a message.
func (s *Session) React(ctx context.Context, messageID int, emoji string) error {
	m, _, err := s.held(messageID)
	if err != nil {
		return err
	}
	var emojis, votes []string
	for _, e := range s.mineOn(m) {
		if isVote(e) {
			votes = append(votes, e)
		} else {
			emojis = append(emojis, e)
		}
	}
	if i := slices.Index(emojis, emoji); i >= 0 {
		emojis = slices.Delete(emojis, i, i+1)
	} else {
		emojis = append(emojis, emoji)[:min(len(emojis)+1, maxEmoji)]
	}
	return s.putReactions(ctx, m, append(emojis, votes...))
}

// Vote sets your vote in a poll to exactly these options (none takes it back); a vote is one of your reactions, "poll:N".
func (s *Session) Vote(ctx context.Context, messageID int, options []int) error {
	m, _, err := s.held(messageID)
	if err != nil {
		return err
	}
	if len(m.Poll) == 0 {
		return &Error{Code: "not_a_poll", Message: "That is not a poll."}
	}
	var next []string
	for _, e := range s.mineOn(m) {
		if !isVote(e) {
			next = append(next, e)
		}
	}
	chosen := slices.Clone(options)
	slices.Sort(chosen)
	for i, o := range slices.Compact(chosen) {
		if o < 0 || o > 99 || i >= maxVotes {
			return &Error{Code: "bad_vote", Message: "That is not a vote this poll can take."}
		}
		next = append(next, fmt.Sprintf("%s%d", voteMarker, o))
	}
	return s.putReactions(ctx, m, next)
}

func (s *Session) mineOn(m *Message) []string {
	var mine []string
	for _, r := range m.Reactions {
		if slices.Contains(r.Users, s.me) {
			mine = append(mine, r.Emoji)
		}
	}
	return mine
}

func (s *Session) putReactions(ctx context.Context, m *Message, next []string) error {
	path := fmt.Sprintf("/api/dm-messages/%d/react", m.ID)
	var raw []byte
	var err error
	if len(next) == 0 {
		var status int
		status, raw, err = s.request(ctx, "POST", path, map[string]any{"sealed": nil})
		if err == nil && status != 200 {
			err = refusal(status, raw)
		}
	} else {
		raw, err = s.post(ctx, m.Conversation, path, 200, func(c *Conversation) (map[string]any, error) {
			return sealedBody(c,
				func() (sealed, error) { return s.v.sealReactions(c.ID, c.Peer, m.ID, next) },
				func() (groupSealed, error) { return s.v.sealGroupReactions(c.ID, c.Members, m.ID, next) })
		})
	}
	if err != nil {
		return err
	}
	var out struct {
		Reactions []rawReaction `json:"reactions"`
	}
	if err := unmarshal(raw, &out); err != nil {
		return err
	}
	s.know(ctx, nil, reactionKeyIDs(out.Reactions))
	s.mutate(func() { s.setReactionsLocked(m.ID, out.Reactions) })
	return nil
}

func reactionKeyIDs(rs []rawReaction) []int {
	var ids []int
	for _, r := range rs {
		ids = append(ids, r.SenderKey, r.RecipientKey)
	}
	return ids
}

func (s *Session) setReactionsLocked(id int, reactions []rawReaction) {
	raw := s.raw[id]
	if raw == nil {
		return
	}
	cp := *raw
	cp.Reactions = reactions
	s.raw[id] = &cp
	s.refreshLocked(id)
}

// OpenFile is a message's file, downloaded and opened; an error when it is gone or does not open (a wrong key). The
// session keeps nothing of it: the caller keeps what it draws.
func (s *Session) OpenFile(ctx context.Context, m *Message) ([]byte, error) {
	if m.File == nil || m.AttachmentHash == "" {
		return nil, &Error{Code: "no_file", Message: "That message has no file."}
	}
	key, ok := unb64(m.File.Key)
	if !ok {
		return nil, &Error{Code: "bad_file", Message: "That file cannot be opened."}
	}
	ctx, cancel := context.WithTimeout(ctx, fileTimeout)
	defer cancel()
	sealedFile, err := s.api.DMDownload(ctx, m.Conversation, m.AttachmentHash)
	if err != nil {
		return nil, &Error{Code: CodeUnreachable, Message: "The file could not be downloaded."}
	}
	plain, ok := openFile(key, sealedFile)
	if !ok {
		return nil, &Error{Code: "bad_file", Message: "That file cannot be opened."}
	}
	return plain, nil
}

// Trust.

// SafetyNumber is the number to compare with the other person, in person: thirty digits in six groups, the same on both
// screens exactly when each sees the other's real key. Empty while either key is not known.
func (s *Session) SafetyNumber(user int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.v.safetyNumber(user)
}

// AcceptKey accepts a person's new key: what is sealed from now on goes to it.
func (s *Session) AcceptKey(user int) {
	s.mutate(func() { s.v.acceptKey(user) })
	go s.reopenAll()
}

// SetVerified records that you compared the safety number with them in person (or takes that back). Verifying accepts a
// change of their key too.
func (s *Session) SetVerified(user int, on bool) {
	s.mutate(func() { s.v.setVerified(user, on) })
	go s.reopenAll()
}
