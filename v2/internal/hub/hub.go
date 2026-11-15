// Package hub keeps the saved servers that are not on screen connected, for what a bubble in the rail says: there is
// news, somebody named you, somebody is in voice, a private message waits, or the server is out of reach or wants a
// new sign-in. A background server is one realtime socket and a few counters; it has no messages, no keys, no media.
package hub

import (
	"context"
	"sync"
	"time"

	"harmony/v2/internal/hclient"
)

// KeepAlive is how often a connection nobody is looking at is touched, so the server does not sweep its session as abandoned.
const KeepAlive = 12 * time.Hour

// MaxLive is how many servers are kept connected at once.
const MaxLive = 8

// State is how a background server is doing.
type State uint8

const (
	Connecting State = iota
	Up
	// Down is a server out of reach: the connection is being dialled again.
	Down
	// Locked is a server that does not accept the session any more and has no way to sign in again alone.
	Locked
)

// Person is somebody in a voice channel, as much as a card needs.
type Person struct {
	UserID   int
	Nickname string
}

// Summary is what the rail shows of one server. A Summary is never changed once handed out.
type Summary struct {
	State    State
	Unread   int
	Mentions int
	// Voice is whether anybody is in one of the server's voice channels, and People who.
	Voice  bool
	People []Person
	// DMUnread is the private messages waiting; DMAvailable whether the server has private messages at all.
	DMUnread    int
	DMAvailable bool
}

// Options says where the hub gets its sign-ins and who it tells.
type Options struct {
	// Credentials is the saved session token and the server's own password for a server.
	Credentials func(url string) (token, door string)
	// Relogin is what signs in again when the server stops accepting the token (see app.Options.Relogin).
	Relogin func(url string) func(ctx context.Context, client *hclient.Client) bool
	// OnChange is called, from any goroutine, when something a bubble shows has changed.
	OnChange func()
	// OnMention is called, from any goroutine, for a message that names the person on a server that is not do not disturb.
	OnMention func(url string, m hclient.ChatMessage)
	// OnLocked is called, from any goroutine, when a server ended the session for good: its saved token is no good.
	OnLocked func(url string)
}

// Hub is the set of background servers.
type Hub struct {
	opt Options

	mu     sync.Mutex
	list   map[string]*background
	away   bool
	closed bool
	stop   chan struct{}
}

func New(opt Options) *Hub {
	h := &Hub{opt: opt, list: map[string]*background{}, stop: make(chan struct{})}
	go h.keepAlive()
	return h
}

// Sync makes the servers kept connected exactly these: those missing are started, the others stopped.
func (h *Hub) Sync(wanted []string) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	keep := make(map[string]bool, len(wanted))
	for _, url := range wanted {
		keep[url] = true
	}
	var gone []*background
	for url, b := range h.list {
		if !keep[url] {
			gone = append(gone, b)
			delete(h.list, url)
		}
	}
	for _, url := range wanted {
		if h.list[url] == nil {
			h.list[url] = h.start(url)
		}
	}
	h.mu.Unlock()
	for _, b := range gone {
		b.close()
	}
	h.opt.OnChange()
}

// Restart drops a server's connection and dials it again from what is saved now, as after it signed in anew.
func (h *Hub) Restart(url string) {
	h.mu.Lock()
	b := h.list[url]
	if b != nil {
		h.list[url] = h.start(url)
	}
	h.mu.Unlock()
	if b != nil {
		b.close()
	}
}

// Summary is what is known of a background server; it reads without waiting and allocates nothing.
func (h *Hub) Summary(url string) (*Summary, bool) {
	h.mu.Lock()
	b := h.list[url]
	h.mu.Unlock()
	if b == nil {
		return nil, false
	}
	return b.snap.Load(), true
}

// SetAway tells every background server the app has not been touched for a while, or has been again.
func (h *Hub) SetAway(away bool) {
	h.mu.Lock()
	if h.away == away {
		h.mu.Unlock()
		return
	}
	h.away = away
	list := make([]*background, 0, len(h.list))
	for _, b := range h.list {
		list = append(list, b)
	}
	h.mu.Unlock()
	for _, b := range list {
		b.sendAway(away)
	}
}

func (h *Hub) awayNow() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.away
}

// Close ends every connection.
func (h *Hub) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	list := h.list
	h.list = map[string]*background{}
	h.mu.Unlock()
	close(h.stop)
	for _, b := range list {
		b.close()
	}
}

// keepAlive touches every connection that is up now and then.
func (h *Hub) keepAlive() {
	tick := time.NewTicker(KeepAlive)
	defer tick.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-tick.C:
		}
		h.mu.Lock()
		list := make([]*background, 0, len(h.list))
		for _, b := range h.list {
			list = append(list, b)
		}
		h.mu.Unlock()
		for _, b := range list {
			b.touch()
		}
	}
}
