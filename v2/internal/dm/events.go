package dm

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"harmony/v2/internal/hclient"
)

// eventQueue hands what the server pushes to one goroutine, in order, without ever making the socket's reader wait:
// applying an event may need the network (for a key not seen yet).
type eventQueue struct {
	mu      sync.Mutex
	items   []hclient.Message
	wake    chan struct{}
	closed  bool
	process func(hclient.Message)
}

func (q *eventQueue) init(process func(hclient.Message)) {
	q.process = process
	q.wake = make(chan struct{}, 1)
	go q.run()
}

func (q *eventQueue) push(msg hclient.Message) {
	q.mu.Lock()
	q.items = append(q.items, msg)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *eventQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *eventQueue) run() {
	for range q.wake {
		for {
			q.mu.Lock()
			if q.closed {
				q.mu.Unlock()
				return
			}
			if len(q.items) == 0 {
				q.mu.Unlock()
				break
			}
			msg := q.items[0]
			q.items[0] = hclient.Message{}
			q.items = q.items[1:]
			q.mu.Unlock()
			q.process(msg)
		}
	}
}

// Handle takes a realtime message from the server if it is about private conversations (keys:changed and dm:*) and
// reports whether it was. It returns at once; the event is applied on the session's own goroutine, in order.
func (s *Session) Handle(msg hclient.Message) bool {
	if msg.Type != "keys:changed" && !strings.HasPrefix(msg.Type, "dm:") {
		return false
	}
	s.events.push(msg)
	return true
}

func (s *Session) process(msg hclient.Message) {
	s.mu.Lock()
	started, ready := s.started, s.v.ready()
	s.mu.Unlock()
	if !started || !ready && msg.Type != "keys:changed" {
		return
	}
	ctx := context.Background()
	switch msg.Type {
	case "keys:changed":
		var m struct {
			Key Key `json:"key"`
		}
		if msg.Decode(&m) == nil {
			s.mutate(func() { s.v.keyChanged(m.Key) })
			s.reopenAll()
		}
	case "dm:message":
		var m struct {
			Message      *rawMessage     `json:"message"`
			Conversation rawConversation `json:"conversation"`
		}
		if msg.Decode(&m) != nil || m.Message == nil {
			return
		}
		s.know(ctx, nil, keyIDs([]*rawMessage{m.Message}, nil))
		s.incoming(m.Message, m.Conversation)
	case "dm:updated":
		var m struct {
			Message *rawMessage `json:"message"`
		}
		if msg.Decode(&m) == nil && m.Message != nil {
			s.know(ctx, nil, keyIDs([]*rawMessage{m.Message}, nil))
			s.mutate(func() { s.updateLocked(m.Message) })
		}
	case "dm:deleted":
		var m struct {
			ID int `json:"id"`
		}
		if msg.Decode(&m) == nil {
			s.dropMessage(m.ID)
		}
	case "dm:reactions":
		var m struct {
			ID        int           `json:"id"`
			Reactions []rawReaction `json:"reactions"`
		}
		if msg.Decode(&m) == nil {
			s.know(ctx, nil, reactionKeyIDs(m.Reactions))
			s.mutate(func() { s.setReactionsLocked(m.ID, m.Reactions) })
		}
	case "dm:read":
		var m struct {
			Conversation int `json:"conversationId"`
			LastRead     int `json:"lastReadId"`
		}
		if msg.Decode(&m) == nil {
			s.mutate(func() { s.readLocked(m.Conversation, m.LastRead) })
		}
	case "dm:cleared", "dm:left":
		var m struct {
			Conversation int `json:"conversationId"`
		}
		if msg.Decode(&m) == nil {
			s.mutate(func() { s.forgetLocked(m.Conversation) })
		}
	case "dm:blocks":
		var m struct {
			Blocked []int `json:"blocked"`
		}
		if msg.Decode(&m) == nil {
			s.mutate(func() {
				s.blocked = map[int]bool{}
				for _, id := range m.Blocked {
					s.blocked[id] = true
				}
			})
		}
	}
}

func (s *Session) readLocked(conversation, lastRead int) {
	c := s.convs[conversation]
	if c == nil {
		return
	}
	cp := *c
	cp.LastRead = max(c.LastRead, lastRead)
	if c.Last != nil && c.Last.ID <= cp.LastRead {
		cp.Unread = 0
	}
	s.convs[conversation] = &cp
}

// incoming applies a message the server pushed and says so to OnIncoming when another person wrote it.
func (s *Session) incoming(raw *rawMessage, view rawConversation) {
	var m *Message
	var c *Conversation
	s.mutate(func() {
		if s.convs[view.ID] == nil {
			s.convs[view.ID] = s.rowLocked(view, false)
		} else {
			s.adoptLocked(view)
		}
		m = s.addLocked(raw, s.convs[view.ID])
		endedCall := raw.Kind == string(KindCall) && callEnded(raw.Meta)
		if raw.User != s.me && !endedCall {
			cp := *s.convs[view.ID]
			cp.Unread++
			s.convs[view.ID] = &cp
		}
		c = s.convs[view.ID]
	})
	if raw.User != s.me && s.onIncoming != nil && m.Kind == KindText {
		s.onIncoming(m, c)
	}
}

func callEnded(meta json.RawMessage) bool {
	var m struct {
		Outcome string `json:"outcome"`
	}
	return json.Unmarshal(meta, &m) == nil && m.Outcome == "ended"
}
