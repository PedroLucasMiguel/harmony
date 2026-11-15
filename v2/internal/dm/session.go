package dm

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/hclient"
)

const (
	pageSize       = 50
	requestTimeout = 20 * time.Second
	fileTimeout    = 5 * time.Minute
)

// Options says who the session is for and how it wakes the screen.
type Options struct {
	Client *hclient.Client
	// Me is the signed-in account's id.
	Me int
	// KeyPath is where this account's keys on this server are kept (see KeyPath); "" keeps them in memory only.
	KeyPath string
	// Changed is called, from any goroutine, whenever something the screen shows has changed. Make it no more than a redraw request.
	Changed func()
	// OnIncoming, when set, is called from the session's own goroutine for a message another person sent, to make a noise or a notification.
	OnIncoming func(m *Message, c *Conversation)
}

// Session is one account's private conversations on one server.
//
// Reading is lock free: Conversations, Thread, Status and the others return immutable values from the latest published
// snapshot and may be called every frame from the UI thread. Anything that asks the server blocks and belongs on a
// goroutine of its own; it wakes the screen through Options.Changed when it has changed something.
type Session struct {
	api        *hclient.Client
	me         int
	changed    func()
	onIncoming func(*Message, *Conversation)

	view atomic.Pointer[view]

	mu           sync.Mutex
	v            *vault
	started      bool
	convs        map[int]*Conversation
	threads      map[int]*threadState
	raw          map[int]*rawMessage
	blocked      map[int]bool
	lockedUnread int
	keysErr      error

	events eventQueue
}

type threadState struct {
	messages []*Message
	pinIDs   []int
	pinned   []*Message
	more     bool
	loading  bool
	err      error
}

// view is what the screen reads: built under the lock and never changed afterwards.
type view struct {
	status  Status
	convs   []*Conversation
	byID    map[int]*Conversation
	threads map[int]*Thread
	blocked map[int]bool
	trust   map[int]Trust
	keyed   map[int]bool
}

// New makes the session; Start brings it up.
func New(opt Options) (*Session, error) {
	file, err := openKeyFile(opt.KeyPath)
	if err != nil {
		return nil, fmt.Errorf("the private conversation keys could not be read: %w", err)
	}
	s := &Session{
		api: opt.Client, me: opt.Me, changed: opt.Changed, onIncoming: opt.OnIncoming,
		v: newVault(file, opt.Me), convs: map[int]*Conversation{}, threads: map[int]*threadState{},
		raw: map[int]*rawMessage{}, blocked: map[int]bool{},
	}
	s.events.init(s.process)
	s.publishLocked()
	return s, nil
}

// Close stops the goroutine that applies what the server pushes.
func (s *Session) Close() { s.events.close() }

func (s *Session) wake() {
	if s.changed != nil {
		s.changed()
	}
}

func (s *Session) snap() *view { return s.view.Load() }

// Status says whether private conversations work yet, and what is waiting.
func (s *Session) Status() Status { return s.snap().status }

// Conversations lists the conversations, the one with the newest activity first. The slice is never written to again.
func (s *Session) Conversations() []*Conversation { return s.snap().convs }

// Conversation is one conversation by id, or nil.
func (s *Session) Conversation(id int) *Conversation { return s.snap().byID[id] }

// Blocked says whether you blocked this person.
func (s *Session) Blocked(user int) bool { return s.snap().blocked[user] }

// CanWriteTo says whether this person has set up private messages (has a key).
func (s *Session) CanWriteTo(user int) bool { return s.snap().keyed[user] }

// Trust is what this computer makes of a person's key.
func (s *Session) Trust(user int) Trust {
	if t, ok := s.snap().trust[user]; ok {
		return t
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.v.trust(user)
}

// Thread is a conversation's messages. The first call for a conversation starts loading its latest page in the
// background and answers a Thread with Loading set; the screen is woken when it arrives. Never nil.
func (s *Session) Thread(conversation int) *Thread {
	v := s.snap()
	if th, ok := v.threads[conversation]; ok {
		return th
	}
	if v.byID[conversation] == nil {
		return &Thread{}
	}
	s.mu.Lock()
	if _, ok := s.threads[conversation]; !ok && s.convs[conversation] != nil {
		s.threads[conversation] = &threadState{loading: true}
		s.publishLocked()
		go s.fetch(conversation, 0)
	}
	s.mu.Unlock()
	if th, ok := s.snap().threads[conversation]; ok {
		return th
	}
	return &Thread{}
}

func (s *Session) publishLocked() {
	v := &view{
		byID: make(map[int]*Conversation, len(s.convs)), threads: make(map[int]*Thread, len(s.threads)),
		blocked: maps(s.blocked), trust: map[int]Trust{}, keyed: map[int]bool{},
	}
	unread := 0
	for id, c := range s.convs {
		v.convs = append(v.convs, c)
		v.byID[id] = c
		unread += c.Unread
		for _, m := range c.Members {
			if _, done := v.trust[m]; !done && m != s.me {
				v.trust[m] = s.v.trust(m)
			}
		}
	}
	for user := range s.v.current {
		v.keyed[user] = true
	}
	slices.SortFunc(v.convs, func(a, b *Conversation) int {
		if a.LastAt != b.LastAt {
			return cmp.Compare(b.LastAt, a.LastAt)
		}
		return b.ID - a.ID
	})
	for id, ts := range s.threads {
		v.threads[id] = &Thread{Messages: ts.messages, Pinned: ts.pinned, More: ts.more, Loading: ts.loading, Err: ts.err}
	}
	if !s.v.ready() {
		unread = s.lockedUnread
	}
	v.status = Status{State: s.v.state, Failure: s.v.failure, NeedsBackup: s.v.needsBackup(), Unread: unread}
	s.view.Store(v)
}

func maps(in map[int]bool) map[int]bool {
	out := make(map[int]bool, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// mutate runs fn under the lock, publishes what it changed and wakes the screen.
func (s *Session) mutate(fn func()) {
	s.mu.Lock()
	fn()
	s.publishLocked()
	s.mu.Unlock()
	s.wake()
}

func (s *Session) request(ctx context.Context, method, path string, body any) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	status, raw, err := s.api.DMRequest(ctx, method, path, body)
	if err != nil {
		return 0, nil, &Error{Code: CodeUnreachable, Message: "Could not reach the server."}
	}
	return status, raw, nil
}

// refusal is an answer that is not a success, as an error a screen can word.
func refusal(status int, raw []byte) *Error {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
		UserID  int    `json:"userId"`
	}
	_ = json.Unmarshal(raw, &e)
	if e.Error == "" {
		e.Error = fmt.Sprintf("http_%d", status)
	}
	if e.Message == "" {
		e.Message = fmt.Sprintf("The server answered %d.", status)
	}
	return &Error{Code: e.Error, Message: e.Message, User: e.UserID, Status: status}
}

// call is request for a route that answers `want` and a JSON body to read into out (nil to ignore it).
func (s *Session) call(ctx context.Context, method, path string, body any, want int, out any) error {
	status, raw, err := s.request(ctx, method, path, body)
	if err != nil {
		return err
	}
	if status != want {
		return refusal(status, raw)
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func unmarshal(raw []byte, out any) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return &Error{Code: "bad_answer", Message: "The server's answer was not understood."}
	}
	return nil
}
