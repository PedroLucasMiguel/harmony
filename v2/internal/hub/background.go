package hub

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/hclient"
)

// callBase is where the rooms of private calls begin; they are not voice channels and are not counted.
const callBase = 100_000_000

const (
	firstRetry = 5 * time.Second
	lastRetry  = time.Minute
	dmDelay    = 400 * time.Millisecond
	touchLimit = 20 * time.Second
)

type count struct{ unread, mentions int }

// background is one server's connection and what is counted from it.
type background struct {
	hub    *Hub
	url    string
	ctx    context.Context
	cancel context.CancelFunc
	client *hclient.Client
	snap   atomic.Pointer[Summary]
	rt     atomic.Pointer[hclient.RT]

	// What is counted, under mu; everybody else reads the snapshot.
	mu       sync.Mutex
	user     hclient.User
	dnd      bool
	counts   map[int]count
	rosters  map[int][]Person
	dmUnread int
	dmHas    bool
	state    State

	dmMu    sync.Mutex
	dmTimer *time.Timer
	rejects atomic.Bool
}

func (h *Hub) start(url string) *background {
	ctx, cancel := context.WithCancel(context.Background())
	b := &background{hub: h, url: url, ctx: ctx, cancel: cancel, counts: map[int]count{}, rosters: map[int][]Person{}}
	b.snap.Store(&Summary{State: Connecting})
	go b.run()
	return b
}

func (b *background) close() {
	b.cancel()
	if rt := b.rt.Load(); rt != nil {
		rt.Close()
	}
	b.dmMu.Lock()
	if b.dmTimer != nil {
		b.dmTimer.Stop()
	}
	b.dmMu.Unlock()
}

// publish makes what is counted the snapshot the rail reads; call with mu held.
func (b *background) publish(state State) {
	b.state = state
	s := &Summary{State: state, DMUnread: b.dmUnread, DMAvailable: b.dmHas}
	for _, c := range b.counts {
		s.Unread += c.unread
		s.Mentions += c.mentions
	}
	for _, id := range sortedKeys(b.rosters) {
		s.People = append(s.People, b.rosters[id]...)
	}
	s.Voice = len(s.People) > 0
	b.snap.Store(s)
	b.hub.opt.OnChange()
}

func sortedKeys(m map[int][]Person) []int {
	ids := make([]int, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

func (b *background) lock() {
	if b.ctx.Err() != nil {
		return
	}
	b.mu.Lock()
	b.publish(Locked)
	b.mu.Unlock()
	if b.hub.opt.OnLocked != nil {
		b.hub.opt.OnLocked(b.url)
	}
}

// run dials until the server answers, then follows what it pushes for as long as the connection lasts.
func (b *background) run() {
	token, door := b.hub.opt.Credentials(b.url)
	if token == "" {
		b.lock()
		return
	}
	b.client = hclient.New(b.url, door, false)
	b.client.Token = token
	if b.hub.opt.Relogin != nil {
		relogin := b.hub.opt.Relogin(b.url)
		b.client.Relogin = func(ctx context.Context) bool { return relogin(ctx, b.client) }
	}
	rt, hello, ok := b.dial()
	if !ok {
		return
	}
	b.rt.Store(rt)
	if b.ctx.Err() != nil {
		rt.Close()
		return
	}
	b.mu.Lock()
	b.apply(hello)
	b.mu.Unlock()
	for msg := range rt.Events {
		b.event(msg)
	}
	if b.ctx.Err() == nil {
		b.lock()
	}
}

// dial tries until the server says hello; false means the hub gave up or was closed.
func (b *background) dial() (*hclient.RT, hclient.Hello, bool) {
	wait := firstRetry
	relogged := false
	for b.ctx.Err() == nil {
		rt, hello, err := hclient.Dial(b.ctx, b.client)
		if err == nil {
			return rt, hello, true
		}
		if errors.Is(err, hclient.ErrRejected) {
			if relogged || b.client.Relogin == nil || !b.client.Relogin(b.ctx) {
				b.lock()
				return nil, hello, false
			}
			relogged = true
			continue
		}
		b.mu.Lock()
		b.publish(Down)
		b.mu.Unlock()
		select {
		case <-b.ctx.Done():
		case <-time.After(wait):
		}
		wait = min(wait*2, lastRetry)
	}
	return nil, hclient.Hello{}, false
}

// apply takes what a hello says: who you are, what is new, who is in voice.
func (b *background) apply(h hclient.Hello) {
	b.user = h.User
	b.dnd = h.Status == "dnd"
	b.counts = make(map[int]count, len(h.Unread))
	for _, m := range h.Unread {
		b.counts[m.ChannelID] = count{m.Unread, m.Mentions}
	}
	b.rosters = map[int][]Person{}
	for id, roster := range h.Rosters {
		b.setRoster(id, roster)
	}
	b.publish(Up)
	if b.hub.awayNow() {
		b.sendAway(true)
	}
	b.refreshDM(0)
}

func (b *background) setRoster(channel int, roster []hclient.Member) {
	if channel > callBase {
		return
	}
	if len(roster) == 0 {
		delete(b.rosters, channel)
		return
	}
	people := make([]Person, len(roster))
	for i, m := range roster {
		people[i] = Person{UserID: m.UserID, Nickname: m.Nickname}
	}
	b.rosters[channel] = people
}

func (b *background) event(msg hclient.Message) {
	b.mu.Lock()
	mention := b.handle(msg)
	closed := b.rejects.Load() && msg.Type == hclient.EventClosed
	b.mu.Unlock()
	if mention != nil && b.hub.opt.OnMention != nil {
		b.hub.opt.OnMention(b.url, *mention)
	}
	if closed {
		b.lock()
	}
}

// handle applies one event, with mu held, and returns the message that names the person, if it was one.
func (b *background) handle(msg hclient.Message) (mention *hclient.ChatMessage) {
	switch msg.Type {
	case hclient.EventDown:
		b.publish(Down)
	case hclient.EventUp:
		var hello hclient.Hello
		if msg.Decode(&hello) == nil {
			b.apply(hello)
		}
	case hclient.EventRejected, "kicked":
		b.rejects.Store(true)
	case "message":
		var m struct {
			Message hclient.ChatMessage `json:"message"`
		}
		if msg.Decode(&m) == nil {
			mention = b.message(m.Message)
		}
	case "message:deleted":
		var m struct {
			ChannelID int `json:"channelId"`
		}
		if msg.Decode(&m) == nil {
			if c, ok := b.counts[m.ChannelID]; ok && c.unread > 0 {
				c.unread--
				b.counts[m.ChannelID] = c
				b.publish(Up)
			}
		}
	case "channel:read":
		var m hclient.ReadMark
		if msg.Decode(&m) == nil {
			b.counts[m.ChannelID] = count{m.Unread, m.Mentions}
			b.publish(Up)
		}
	case "channels":
		var m struct {
			Channels []struct {
				ID int `json:"id"`
			} `json:"channels"`
		}
		if msg.Decode(&m) == nil {
			b.forgetChannels(m.Channels)
		}
	case "presence:self":
		var m struct {
			Status string `json:"status"`
		}
		if msg.Decode(&m) == nil {
			b.dnd = m.Status == "dnd"
		}
	case "voice:roster":
		var m struct {
			ChannelID int              `json:"channelId"`
			Roster    []hclient.Member `json:"roster"`
		}
		if msg.Decode(&m) == nil && m.ChannelID <= callBase {
			b.setRoster(m.ChannelID, m.Roster)
			b.publish(Up)
		}
	case "dm:message", "dm:read", "dm:cleared", "dm:left":
		b.refreshDM(dmDelay)
	}
	return mention
}

func (b *background) forgetChannels(list []struct {
	ID int `json:"id"`
}) {
	changed := false
	for id := range b.counts {
		if !slices.ContainsFunc(list, func(c struct {
			ID int `json:"id"`
		}) bool {
			return c.ID == id
		}) {
			delete(b.counts, id)
			changed = true
		}
	}
	if changed {
		b.publish(Up)
	}
}

func (b *background) message(m hclient.ChatMessage) *hclient.ChatMessage {
	if m.UserID == b.user.ID {
		return nil
	}
	c := b.counts[m.ChannelID]
	c.unread++
	named := chat.MentionsUser(m, b.user)
	if named {
		c.mentions++
	}
	b.counts[m.ChannelID] = c
	b.publish(Up)
	if named && !b.dnd {
		return &m
	}
	return nil
}

func (b *background) sendAway(away bool) {
	rt := b.rt.Load()
	if rt == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(b.ctx, touchLimit)
		defer cancel()
		_, _ = rt.Request(ctx, "presence:away", map[string]any{"away": away})
	}()
}

// refreshDM counts the private messages waiting, after delay so a burst is asked for once. The count is the server's,
// so it needs no keys.
func (b *background) refreshDM(delay time.Duration) {
	b.dmMu.Lock()
	defer b.dmMu.Unlock()
	if b.dmTimer != nil {
		b.dmTimer.Stop()
	}
	b.dmTimer = time.AfterFunc(delay, b.fetchDM)
}

func (b *background) fetchDM() {
	ctx, cancel := context.WithTimeout(b.ctx, touchLimit)
	defer cancel()
	status, raw, err := b.client.DMRequest(ctx, "GET", "/api/dms", nil)
	if err != nil {
		return
	}
	unread, has := dmUnread(status, raw)
	b.mu.Lock()
	b.dmUnread, b.dmHas = unread, has
	b.publish(b.state)
	b.mu.Unlock()
}

// touch asks the server who this is, which counts as being used.
func (b *background) touch() {
	if state := b.snap.Load().State; state != Up && state != Down {
		return
	}
	ctx, cancel := context.WithTimeout(b.ctx, touchLimit)
	defer cancel()
	if _, err := b.client.Me(ctx); hclient.IsExpired(err) {
		b.lock()
	}
}

// dmUnread reads the answer of the list of private conversations: how many messages wait, and whether the server has them.
func dmUnread(status int, raw []byte) (unread int, has bool) {
	if status != 200 {
		return 0, false
	}
	var out struct {
		Conversations []struct {
			Unread int `json:"unread"`
		} `json:"conversations"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return 0, false
	}
	for _, c := range out.Conversations {
		unread += c.Unread
	}
	return unread, true
}
