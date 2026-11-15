package channels

import (
	"context"
	"encoding/json"
	"errors"
	"mime"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/dm"
	"harmony/v2/internal/hclient"
)

const (
	dmFileMax     = 25 << 20
	dmCallSecs    = 60
	dmVotePrefix  = "poll:"
	dmActionLimit = 15 * time.Second
)

// chatFeed is what the chat view reads and does with its messages: a channel's store, or a private conversation.
type chatFeed interface {
	Messages(id int) (entries []*chat.Entry, more, loading bool)
	LoadOlder(id int)
	MarkRead(id, upTo int)
	Unread(id int) hclient.ReadMark
	SetOpen(id int)
	Typing(id int) []int
	Typed(id int)
	Stopped(id int)
	Pinned(id int) []hclient.ChatMessage
	CanPin() bool
	Pin(ctx context.Context, id int, pinned bool) error
	Send(ctx context.Context, id int, post hclient.Post) error
	Edit(ctx context.Context, id int, body string) error
	Delete(ctx context.Context, id int) error
	React(ctx context.Context, id int, emoji string, on bool) error
	Vote(ctx context.Context, id, message int, options []int) error
	SendFiles(id int, body string, paths []string, replyTo int) *chat.Sending
	SendFile(id int, name, contentType string, data []byte, replyTo int) *chat.Sending
	SendPoll(id int, draft hclient.PollDraft, picture string) *chat.Sending
	Bytes(hash string) func() ([]byte, error)
	Head(hash string, size int64) chat.Head
	PeekHead(hash string) (chat.Head, bool)
	Save(hash, name string) (string, error)
}

var _ chatFeed = (*chat.Store)(nil)

// dmFeed shows private conversations to the chat view: their messages as the entries a channel's are, and what is done
// to them as the core does it.
type dmFeed struct {
	session *dm.Session
	me      int
	t       func(key string, vars ...string) string
	members []hclient.Account
	changed func()

	threads map[int]*dmThread

	mu    sync.Mutex
	files map[string]*dm.Message
	heads map[string]*chat.Head
}

type dmThread struct {
	src    []*dm.Message
	out    []*chat.Entry
	pinSrc []*dm.Message
	pins   []hclient.ChatMessage
}

var _ chatFeed = (*dmFeed)(nil)

func newDMFeed(session *dm.Session, me int, changed func()) *dmFeed {
	return &dmFeed{
		session: session, me: me, changed: changed,
		threads: map[int]*dmThread{}, files: map[string]*dm.Message{}, heads: map[string]*chat.Head{},
	}
}

func sameMessages(a, b []*dm.Message) bool {
	return len(a) == len(b) && (len(a) == 0 || &a[0] == &b[0])
}

func (f *dmFeed) thread(id int) *dmThread {
	t := f.threads[id]
	if t == nil {
		t = &dmThread{}
		f.threads[id] = t
	}
	return t
}

func (f *dmFeed) Messages(id int) ([]*chat.Entry, bool, bool) {
	th := f.session.Thread(id)
	t := f.thread(id)
	if !sameMessages(t.src, th.Messages) {
		out := make([]*chat.Entry, len(th.Messages))
		for i, m := range th.Messages {
			out[i] = f.entryOf(m)
		}
		t.src, t.out = th.Messages, out
	}
	return t.out, th.More, th.Loading
}

func (f *dmFeed) entryOf(m *dm.Message) *chat.Entry {
	if e, ok := m.Layout.(*chat.Entry); ok {
		return e
	}
	e := &chat.Entry{Msg: f.convert(m), Layout: &entryLayout{dm: m}}
	m.Layout = e
	return e
}

func (f *dmFeed) Pinned(id int) []hclient.ChatMessage {
	th := f.session.Thread(id)
	t := f.thread(id)
	if !sameMessages(t.pinSrc, th.Pinned) {
		out := make([]hclient.ChatMessage, len(th.Pinned))
		for i, m := range th.Pinned {
			out[i] = f.convert(m)
		}
		t.pinSrc, t.pins = th.Pinned, out
	}
	return t.pins
}

// dmOf is the private message an entry stands for, or nil for a channel's.
func dmOf(e *chat.Entry) *dm.Message {
	if l, ok := e.Layout.(*entryLayout); ok {
		return l.dm
	}
	return nil
}

func (f *dmFeed) convert(m *dm.Message) hclient.ChatMessage {
	msg := hclient.ChatMessage{
		ID: m.ID, ChannelID: m.Conversation, UserID: m.User, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt, Pinned: m.Pinned,
	}
	switch {
	case m.Unreadable:
		key := "dm.unreadable"
		if m.OutOfPlace {
			key = "dm.out_of_place"
		}
		msg.Body = "*" + f.t(key) + "*"
	case m.Kind == dm.KindCall:
		msg.Body = "*" + f.callLine(m) + "*"
	case m.Kind == dm.KindGroup:
		msg.Body = "*" + f.groupLine(m) + "*"
	default:
		f.convertText(&msg, m)
	}
	return msg
}

func (f *dmFeed) convertText(msg *hclient.ChatMessage, m *dm.Message) {
	msg.Body = m.Body
	if r := m.Reply; r != nil {
		msg.Reply = &hclient.Reply{ID: r.ID, UserID: r.User, Body: r.Body, AttachmentName: r.AttachmentName, Deleted: r.Deleted}
		msg.ReplyTo = r.ID
	}
	if file := m.File; file != nil && m.AttachmentHash != "" {
		msg.AttachmentHash, msg.AttachmentName, msg.AttachmentBytes, msg.MediaType = m.AttachmentHash, file.Name, file.Size, file.Media
		f.mu.Lock()
		f.files[m.AttachmentHash] = m
		f.mu.Unlock()
	}
	var votes []dm.Reaction
	for _, r := range m.Reactions {
		if _, ok := voteOption(r.Emoji); ok {
			votes = append(votes, r)
			continue
		}
		msg.Reactions = append(msg.Reactions, hclient.Reaction{Emoji: r.Emoji, Count: r.Count, UserIDs: r.Users})
	}
	if len(m.Poll) > 0 {
		var p hclient.Poll
		if json.Unmarshal(m.Poll, &p) == nil && p.Title != "" && len(p.Options) >= 2 {
			p.Results = pollResults(&p, votes, f.me)
			msg.Poll = &p
		}
	}
}

func voteOption(emoji string) (int, bool) {
	rest, ok := strings.CutPrefix(emoji, dmVotePrefix)
	if !ok || len(rest) == 0 || len(rest) > 2 {
		return 0, false
	}
	n, err := strconv.Atoi(rest)
	return n, err == nil && n >= 0
}

// pollResults counts the votes a private poll has: each is a reaction "poll:N", so everybody who can open the message counts them the same way.
func pollResults(p *hclient.Poll, votes []dm.Reaction, me int) *hclient.PollResults {
	n := len(p.Options)
	res := &hclient.PollResults{Counts: make([]int, n), Voters: make([][]int, n)}
	first := map[int]int{}
	for _, r := range votes {
		option, _ := voteOption(r.Emoji)
		if option >= n {
			continue
		}
		for _, id := range r.Users {
			if prev, ok := first[id]; !p.Multiple && ok && prev < option {
				continue
			}
			first[id] = option
		}
	}
	who := map[int]bool{}
	for _, r := range votes {
		option, _ := voteOption(r.Emoji)
		if option >= n {
			continue
		}
		for _, id := range r.Users {
			if !p.Multiple && first[id] != option || slices.Contains(res.Voters[option], id) {
				continue
			}
			res.Voters[option] = append(res.Voters[option], id)
			res.Counts[option]++
			who[id] = true
			if id == me {
				res.Mine = append(res.Mine, option)
			}
		}
	}
	slices.Sort(res.Mine)
	res.Total = len(who)
	if p.Anonymous {
		res.Voters = nil
	}
	return res
}

// pollBody is a poll as plain words: what somebody whose app has no polls sees, and what a search finds.
func pollBody(d hclient.PollDraft) string {
	lines := []string{"\U0001F4CA " + d.Title}
	for i, o := range d.Options {
		lines = append(lines, strconv.Itoa(i+1)+". "+o)
	}
	body := strings.Join(lines, "\n")
	if r := []rune(body); len(r) > dm.MaxBody {
		body = string(r[:dm.MaxBody])
	}
	return body
}

func (f *dmFeed) name(id int) string {
	for _, a := range f.members {
		if a.ID == id {
			return a.Name()
		}
	}
	return f.t("reactions.someone")
}

func (f *dmFeed) names(ids []int) string {
	list := make([]string, len(ids))
	for i, id := range ids {
		list[i] = f.name(id)
	}
	return strings.Join(list, ", ")
}

func (f *dmFeed) callLine(m *dm.Message) string {
	var meta struct {
		Outcome    string `json:"outcome"`
		DurationMs int64  `json:"durationMs"`
	}
	_ = json.Unmarshal(m.Line, &meta)
	mine := m.User == f.me
	switch meta.Outcome {
	case "ended":
		secs := (meta.DurationMs + 500) / 1000
		length := strconv.FormatInt(max(1, secs), 10) + " s"
		if secs >= dmCallSecs {
			length = strconv.FormatInt(secs/60, 10) + " min"
		}
		return f.t("dm.call_ended", "length", length)
	case "declined":
		if mine {
			return f.t("dm.call_declined_by_them")
		}
		return f.t("dm.call_declined")
	}
	if mine {
		return f.t("dm.call_unanswered")
	}
	return f.t("dm.call_missed")
}

func (f *dmFeed) groupLine(m *dm.Message) string {
	var meta struct {
		Event string `json:"event"`
		By    int    `json:"by"`
		Users []int  `json:"users"`
		Owner *int   `json:"owner"`
		Title string `json:"title"`
	}
	if json.Unmarshal(m.Line, &meta) != nil {
		return ""
	}
	by := f.name(meta.By)
	switch meta.Event {
	case "created", "added", "removed":
		return f.t("dm.group.line."+meta.Event, "by", by, "users", f.names(meta.Users))
	case "left":
		if meta.Owner != nil {
			return f.t("dm.group.line.left_owner", "by", by, "owner", f.name(*meta.Owner))
		}
		return f.t("dm.group.line.left", "by", by)
	case "renamed":
		return f.t("dm.group.line.renamed", "by", by, "title", meta.Title)
	}
	return ""
}

// words is a refusal in the page's own words.
func (f *dmFeed) words(err error) error {
	var e *dm.Error
	if err == nil || !errors.As(err, &e) {
		return err
	}
	who := ""
	if e.User != 0 {
		who = f.name(e.User)
	}
	named := func(plain, member string) string {
		if who != "" {
			return f.t(member, "name", who)
		}
		return f.t(plain)
	}
	switch e.Code {
	case dm.CodeNoKey:
		return errors.New(f.t("dm.error.no_key"))
	case dm.CodePeerHasNoKey:
		return errors.New(named("dm.error.peer_has_no_key", "dm.error.member_no_key"))
	case dm.CodeKeyNotConfirm:
		return errors.New(named("dm.error.key_not_confirmed", "dm.error.member_key_not_confirmed"))
	case "forbidden", "bad_title", "too_few", "too_many", "already_members", "not_a_member", "no_such_user", "blocked", "file_too_large", "slow_down":
		return errors.New(f.t("dm.error." + e.Code))
	case dm.CodeTooLong:
		return errors.New(f.t("dm.error.too_long", "max", strconv.Itoa(dm.MaxBody)))
	case "poll_closed", "bad_vote", "poll_needs_title", "poll_needs_options":
		return errors.New(f.t("poll.err_" + e.Code))
	case dm.CodeUnreachable:
		return errors.New(e.Message)
	}
	if e.Message != "" {
		return errors.New(e.Message)
	}
	return errors.New(f.t("dm.error.generic"))
}

func (f *dmFeed) LoadOlder(id int)   { f.session.LoadOlder(id) }
func (f *dmFeed) MarkRead(id, _ int) { f.session.MarkRead(id) }
func (f *dmFeed) SetOpen(int)        {}
func (f *dmFeed) Typing(int) []int   { return nil }
func (f *dmFeed) Typed(int)          {}
func (f *dmFeed) Stopped(int)        {}
func (f *dmFeed) CanPin() bool       { return true }
func (f *dmFeed) Pin(ctx context.Context, id int, pinned bool) error {
	return f.words(f.session.Pin(ctx, id, pinned))
}

func (f *dmFeed) Unread(id int) hclient.ReadMark {
	c := f.session.Conversation(id)
	if c == nil {
		return hclient.ReadMark{ChannelID: id}
	}
	return hclient.ReadMark{ChannelID: id, Unread: c.Unread, LastReadID: c.LastRead}
}

func (f *dmFeed) Send(ctx context.Context, id int, post hclient.Post) error {
	_, err := f.session.Send(ctx, id, dm.Outgoing{Body: post.Body, Reply: f.session.MessageByID(post.ReplyTo)})
	return f.words(err)
}

func (f *dmFeed) Edit(ctx context.Context, id int, body string) error {
	return f.words(f.session.Edit(ctx, id, body))
}

func (f *dmFeed) Delete(ctx context.Context, id int) error {
	return f.words(f.session.Remove(ctx, id))
}

func (f *dmFeed) React(ctx context.Context, id int, emoji string, on bool) error {
	m := f.session.MessageByID(id)
	if m == nil {
		return f.words(&dm.Error{Code: dm.CodeNoMessage, Message: "No such message."})
	}
	for _, r := range m.Reactions {
		if r.Emoji == emoji && slices.Contains(r.Users, f.me) == on {
			return nil
		}
	}
	return f.words(f.session.React(ctx, id, emoji))
}

func (f *dmFeed) Vote(ctx context.Context, _, message int, options []int) error {
	return f.words(f.session.Vote(ctx, message, options))
}

// Files.

func (f *dmFeed) open(hash string) ([]byte, error) {
	f.mu.Lock()
	m := f.files[hash]
	f.mu.Unlock()
	if m == nil {
		return nil, errors.New(f.t("dm.file_unreadable"))
	}
	data, err := f.session.OpenFile(context.Background(), m)
	if err != nil {
		return nil, f.words(err)
	}
	return data, nil
}

func (f *dmFeed) Bytes(hash string) func() ([]byte, error) {
	return func() ([]byte, error) { return f.open(hash) }
}

func (f *dmFeed) Head(hash string, size int64) chat.Head {
	f.mu.Lock()
	defer f.mu.Unlock()
	if h, ok := f.heads[hash]; ok {
		return *h
	}
	h := &chat.Head{}
	f.heads[hash] = h
	go func() {
		data, err := f.open(hash)
		f.mu.Lock()
		if err != nil || slices.Contains(data, 0) {
			*h = chat.Head{Binary: true, Ready: true}
		} else {
			*h = chat.Excerpt(data, size)
		}
		f.mu.Unlock()
		f.changed()
	}()
	return chat.Head{}
}

func (f *dmFeed) PeekHead(hash string) (chat.Head, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if h, ok := f.heads[hash]; ok {
		return *h, true
	}
	return chat.Head{}, false
}

func (f *dmFeed) Save(hash, name string) (string, error) {
	data, err := f.open(hash)
	if err != nil {
		return "", err
	}
	return chat.SaveFile(name, hash, data)
}

// Sending.

type dmUpload struct {
	name, mime string
	data       func() ([]byte, error)
	size       int64
}

// run sends each upload as a message of its own, the words and the reply going with the last, and reports progress as the files go.
func (f *dmFeed) run(id int, body string, replyTo int, uploads []dmUpload) *chat.Sending {
	op := &chat.Sending{}
	var total int64
	for _, u := range uploads {
		total += u.size
	}
	op.Total.Store(total)
	go func() {
		defer func() { op.Done.Store(true); f.changed() }()
		for i, u := range uploads {
			op.Name.Store(u.name)
			words, reply := "", 0
			if i == len(uploads)-1 {
				words, reply = body, replyTo
			}
			if err := f.sendOne(id, words, reply, u); err != nil {
				op.Err.Store(err)
				return
			}
			op.Sent.Add(u.size)
			f.changed()
		}
	}()
	return op
}

func (f *dmFeed) sendOne(id int, body string, replyTo int, u dmUpload) error {
	if u.size > dmFileMax {
		return f.words(&dm.Error{Code: "file_too_large"})
	}
	data, err := u.data()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	out := dm.Outgoing{Body: body, File: &dm.Attachment{Name: u.name, Mime: u.mime, Data: data}, Reply: f.session.MessageByID(replyTo)}
	_, err = f.session.Send(ctx, id, out)
	return f.words(err)
}

func (f *dmFeed) SendFiles(id int, body string, paths []string, replyTo int) *chat.Sending {
	uploads := make([]dmUpload, 0, len(paths))
	for _, p := range paths {
		var size int64
		if info, err := os.Stat(p); err == nil {
			size = info.Size()
		}
		name := filepath.Base(p)
		kind := strings.SplitN(mime.TypeByExtension(strings.ToLower(filepath.Ext(name))), ";", 2)[0]
		uploads = append(uploads, dmUpload{name: name, mime: kind, size: size, data: func() ([]byte, error) { return os.ReadFile(p) }})
	}
	return f.run(id, body, replyTo, uploads)
}

func (f *dmFeed) SendFile(id int, name, contentType string, data []byte, replyTo int) *chat.Sending {
	return f.run(id, "", replyTo, []dmUpload{{name: name, mime: contentType, size: int64(len(data)), data: func() ([]byte, error) { return data, nil }}})
}

func (f *dmFeed) SendPoll(id int, draft hclient.PollDraft, picture string) *chat.Sending {
	op := &chat.Sending{}
	go func() {
		defer func() { op.Done.Store(true); f.changed() }()
		if err := f.sendPoll(id, draft, picture); err != nil {
			op.Err.Store(err)
		}
	}()
	return op
}

func (f *dmFeed) sendPoll(id int, draft hclient.PollDraft, picture string) error {
	type wire struct {
		hclient.PollDraft
		EndsAt *int64 `json:"endsAt"`
	}
	w := wire{PollDraft: draft}
	if draft.EndsAt != 0 {
		w.EndsAt = &draft.EndsAt
	}
	raw, _ := json.Marshal(w)
	out := dm.Outgoing{Body: pollBody(draft), Poll: raw}
	if picture != "" {
		info, err := os.Stat(picture)
		if err != nil {
			return err
		}
		if info.Size() > dmFileMax {
			return f.words(&dm.Error{Code: "file_too_large"})
		}
		data, err := os.ReadFile(picture)
		if err != nil {
			return err
		}
		name := filepath.Base(picture)
		out.File = &dm.Attachment{Name: name, Mime: strings.SplitN(mime.TypeByExtension(strings.ToLower(filepath.Ext(name))), ";", 2)[0], Data: data}
	}
	ctx, cancel := context.WithTimeout(context.Background(), dmActionLimit*8)
	defer cancel()
	_, err := f.session.Send(ctx, id, out)
	return f.words(err)
}
