// Package chat keeps the text channels' messages, who is typing, and the link cards, and does the talking to the server for them.
package chat

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/hclient"
)

const (
	typingShown  = 5 * time.Second
	typingEvery  = 3 * time.Second
	typingIdle   = 2 * time.Second
	previewSlots = 3
	pageSize     = 50
)

// Entry is one message. Entries are never changed once shared: an edit replaces the entry, so a reader may keep one.
type Entry struct {
	Msg hclient.ChatMessage
	// Layout belongs to whoever draws the entry; it goes with the entry when the message is edited.
	Layout any
}

type feed struct {
	entries []*Entry
	loading bool
	loaded  bool
	more    bool
	post    *hclient.ChatMessage
	gone    bool
}

type PreviewState int

const (
	PreviewLoading PreviewState = iota
	PreviewReady
	PreviewNone
)

type previewSlot struct {
	state   PreviewState
	preview *hclient.LinkPreview
}

type Store struct {
	client  *hclient.Client
	rt      *hclient.RT
	changed func()

	mu       sync.Mutex
	feeds    map[int]*feed
	typing   map[int]map[int]time.Time
	typedAt  map[int]time.Time
	idle     map[int]*time.Timer
	previews map[string]*previewSlot
	slots    chan struct{}
	read     map[int]int
	reads    readState
	pins     pinBook
	forum    forumState
	heads    map[string]*Head
	emojis   atomic.Pointer[EmojiSet]

	// OnMention is called, from the connection's goroutine, for a message another person wrote that names this person.
	OnMention func(hclient.ChatMessage)
}

func New(client *hclient.Client, rt *hclient.RT, changed func()) *Store {
	s := &Store{
		client: client, rt: rt, changed: changed,
		feeds: map[int]*feed{}, typing: map[int]map[int]time.Time{}, typedAt: map[int]time.Time{}, idle: map[int]*time.Timer{},
		previews: map[string]*previewSlot{}, slots: make(chan struct{}, previewSlots), read: map[int]int{}, heads: map[string]*Head{},
	}
	go s.loadEmojis()
	return s
}

func (s *Store) feedOf(channel int) *feed {
	f := s.feeds[channel]
	if f == nil {
		f = &feed{}
		s.feeds[channel] = f
	}
	return f
}

// Messages returns a channel's messages, oldest first. The slice is never written to again, so it can be read without a lock.
// The first call for a channel starts loading its latest page.
func (s *Store) Messages(channel int) (entries []*Entry, more, loading bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.feedOf(channel)
	if !f.loaded && !f.loading && !f.gone {
		f.loading = true
		go s.fetch(channel, 0)
	}
	return f.entries, f.more, f.loading
}

// LoadOlder fetches the page before the oldest message held.
func (s *Store) LoadOlder(channel int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.feedOf(channel)
	if f.loading || !f.more || len(f.entries) == 0 {
		return
	}
	f.loading = true
	go s.fetch(channel, f.entries[0].Msg.ID)
}

func (s *Store) fetch(channel, before int) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	reply, err := s.page(ctx, channel, before, 0)
	page := reply.Messages
	s.mu.Lock()
	f := s.feedOf(channel)
	f.loading = false
	f.noteReply(reply, err)
	if err == nil {
		f.loaded = true
		f.more = len(page) >= pageSize
		s.pins.set(channel, reply.Pinned)
		fresh := make([]*Entry, 0, len(page)+len(f.entries))
		for i := range page {
			fresh = append(fresh, &Entry{Msg: page[i]})
		}
		for _, e := range f.entries {
			if !hasID(fresh, e.Msg.ID) {
				fresh = append(fresh, e)
			}
		}
		slices.SortStableFunc(fresh, func(a, b *Entry) int { return a.Msg.ID - b.Msg.ID })
		f.entries = fresh
	}
	s.mu.Unlock()
	s.changed()
}

func hasID(entries []*Entry, id int) bool {
	return slices.ContainsFunc(entries, func(e *Entry) bool { return e.Msg.ID == id })
}

// Handle applies a realtime message; it reports whether it was one about chat.
func (s *Store) Handle(msg hclient.Message) bool {
	switch msg.Type {
	case "message", "message:updated":
		var m struct {
			Message hclient.ChatMessage `json:"message"`
		}
		if msg.Decode(&m) != nil {
			return true
		}
		s.put(m.Message)
		s.clearTyping(routeKey(m.Message), m.Message.UserID)
		s.noteForum(msg.Type == "message", m.Message)
		if msg.Type == "message" {
			s.noteIncoming(m.Message)
		}
	case "message:reactions":
		var m struct {
			ID        int                `json:"id"`
			ChannelID int                `json:"channelId"`
			Reactions []hclient.Reaction `json:"reactions"`
		}
		if msg.Decode(&m) != nil {
			return true
		}
		s.setReactions(m.ChannelID, m.ID, m.Reactions)
		s.forumReactions(m.ID, m.Reactions)
	case "message:poll":
		var m struct {
			ID        int                 `json:"id"`
			ChannelID int                 `json:"channelId"`
			Results   hclient.PollResults `json:"results"`
		}
		if msg.Decode(&m) != nil {
			return true
		}
		s.setPollResults(m.ChannelID, m.ID, m.Results)
	case "emojis":
		var m struct {
			Emojis []hclient.CustomEmoji `json:"emojis"`
		}
		if msg.Decode(&m) == nil {
			s.setEmojis(m.Emojis)
		}
	case "message:deleted":
		var m struct {
			ID        int  `json:"id"`
			ChannelID int  `json:"channelId"`
			Post      bool `json:"post"`
			ThreadID  int  `json:"threadId"`
		}
		if msg.Decode(&m) != nil {
			return true
		}
		s.removed(m.ChannelID, m.ID, m.ThreadID, m.Post)
		s.noteDeleted(m.ChannelID)
	case "channel:read":
		var m hclient.ReadMark
		if msg.Decode(&m) == nil {
			s.setMark(m)
		}
	case "typing":
		var m struct {
			Scope   string `json:"scope"`
			ID      int    `json:"id"`
			UserID  int    `json:"userId"`
			Stopped bool   `json:"stopped"`
			Thread  int    `json:"thread"`
		}
		if msg.Decode(&m) != nil || m.Scope != "channel" {
			return true
		}
		key := m.ID
		if m.Thread != 0 {
			key = ThreadKey(m.Thread)
		}
		if m.Stopped {
			s.clearTyping(key, m.UserID)
		} else {
			s.noteTyping(key, m.UserID)
		}
	default:
		return false
	}
	return true
}

func (s *Store) put(m hclient.ChatMessage) {
	key := routeKey(m)
	s.mu.Lock()
	f := s.feeds[key]
	if f == nil || !f.loaded {
		s.mu.Unlock()
		return
	}
	entries := slices.Clone(f.entries)
	entry := &Entry{Msg: m}
	if i := slices.IndexFunc(entries, func(e *Entry) bool { return e.Msg.ID == m.ID }); i >= 0 {
		entries[i] = entry
	} else {
		entries = append(entries, entry)
	}
	f.entries = entries
	s.pins.note(key, m)
	s.mu.Unlock()
	s.changed()
}

func (s *Store) remove(channel, id int) {
	s.mu.Lock()
	s.pins.drop(channel, id)
	f := s.feeds[channel]
	if f == nil {
		s.mu.Unlock()
		return
	}
	f.entries = slices.DeleteFunc(slices.Clone(f.entries), func(e *Entry) bool { return e.Msg.ID == id })
	s.mu.Unlock()
	s.changed()
}

// Send posts a message and shows it at once; the echo from the server finds it already there.
func (s *Store) Send(ctx context.Context, channel int, post hclient.Post) error {
	forum, thread := s.target(channel)
	post.ThreadID = thread
	msg, err := s.client.Send(ctx, forum, post)
	if err != nil {
		return err
	}
	s.put(msg)
	s.mu.Lock()
	if t := s.idle[channel]; t != nil {
		t.Stop()
	}
	delete(s.idle, channel)
	delete(s.typedAt, channel)
	s.mu.Unlock()
	return nil
}

func (s *Store) Edit(ctx context.Context, id int, body string) error {
	return s.client.EditMessage(ctx, id, body)
}

func (s *Store) Delete(ctx context.Context, id int) error {
	return s.client.DeleteMessage(ctx, id)
}

// MarkRead says everything up to a message has been read, once per message.
func (s *Store) MarkRead(channel, upTo int) {
	if channel < 0 {
		s.MarkForumRead(s.forumOf(channel))
		return
	}
	s.mu.Lock()
	if s.read[channel] >= upTo {
		s.mu.Unlock()
		return
	}
	s.read[channel] = upTo
	s.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.client.MarkRead(ctx, channel, upTo)
	}()
}

// Preview is the card for a link: it is asked of the server once, and answers PreviewLoading until then.
func (s *Store) Preview(address string) (*hclient.LinkPreview, PreviewState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slot, ok := s.previews[address]; ok {
		return slot.preview, slot.state
	}
	s.previews[address] = &previewSlot{}
	go s.askPreview(address)
	return nil, PreviewLoading
}

// PeekPreview is Preview without starting a request.
func (s *Store) PeekPreview(address string) (*hclient.LinkPreview, PreviewState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slot, ok := s.previews[address]; ok {
		return slot.preview, slot.state
	}
	return nil, PreviewLoading
}

func (s *Store) askPreview(address string) {
	s.slots <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	preview, err := s.client.LinkPreview(ctx, address)
	cancel()
	<-s.slots
	s.mu.Lock()
	switch {
	case err != nil:
		delete(s.previews, address)
	case preview == nil:
		s.previews[address] = &previewSlot{state: PreviewNone}
	default:
		s.previews[address] = &previewSlot{state: PreviewReady, preview: preview}
	}
	s.mu.Unlock()
	if err == nil {
		s.changed()
	}
}

func (s *Store) noteTyping(channel, user int) {
	s.mu.Lock()
	if s.typing[channel] == nil {
		s.typing[channel] = map[int]time.Time{}
	}
	s.typing[channel][user] = time.Now().Add(typingShown)
	s.mu.Unlock()
	time.AfterFunc(typingShown, s.changed)
	s.changed()
}

func (s *Store) clearTyping(channel, user int) {
	s.mu.Lock()
	_, was := s.typing[channel][user]
	delete(s.typing[channel], user)
	s.mu.Unlock()
	if was {
		s.changed()
	}
}

// Typing lists who is writing in a channel, the one who started first first.
func (s *Store) Typing(channel int) []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	type who struct {
		id    int
		until time.Time
	}
	var list []who
	for id, until := range s.typing[channel] {
		if until.After(now) {
			list = append(list, who{id, until})
		}
	}
	slices.SortFunc(list, func(a, b who) int { return a.until.Compare(b.until) })
	ids := make([]int, len(list))
	for i, w := range list {
		ids[i] = w.id
	}
	return ids
}

// Typed is called at every keystroke in a channel's box: it tells the server now and then, and says "stopped" once the keys go quiet.
func (s *Store) Typed(channel int) {
	s.mu.Lock()
	send := time.Since(s.typedAt[channel]) >= typingEvery
	if send {
		s.typedAt[channel] = time.Now()
	}
	if t := s.idle[channel]; t != nil {
		t.Stop()
	}
	s.idle[channel] = time.AfterFunc(typingIdle, func() { s.Stopped(channel) })
	s.mu.Unlock()
	if send {
		go s.sendTyping(channel, false)
	}
}

// Stopped says you are no longer writing in a channel, if the server was told you were.
func (s *Store) Stopped(channel int) {
	s.mu.Lock()
	t := s.idle[channel]
	delete(s.idle, channel)
	delete(s.typedAt, channel)
	s.mu.Unlock()
	if t == nil {
		return
	}
	t.Stop()
	go s.sendTyping(channel, true)
}
