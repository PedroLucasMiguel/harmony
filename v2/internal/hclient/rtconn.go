package hclient

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// What the connection puts on RT.Events itself, among what the server pushes.
const (
	// EventDown says the socket was lost and is being dialled again.
	EventDown = "rt:down"
	// EventUp says it is back; Raw is the new hello-ok, which says everything that happened while it was away.
	EventUp = "rt:up"
	// EventRejected says the server no longer accepts the session token. Nothing more will arrive.
	EventRejected = "rt:rejected"
	// EventClosed says the server hung up on purpose (a kick or a ban, which came before it as a `kicked` event). Nothing more will arrive.
	EventClosed = "rt:closed"
)

const (
	closeRejected = 4401
	closeForbid   = 4403
)

// ErrRejected is what the server says to a session token it does not know any more.
var ErrRejected = errors.New("the server does not accept this session")

// ErrNotConnected is what a request gets while the socket is down.
var ErrNotConnected = errors.New("not connected to the server")

// timing is how the connection keeps watch. The heartbeat asks the server whether it is still there; the watchdog drops a
// socket that has delivered nothing at all for too long, the half-open kind that stays up for ever after a sleep or a roam.
type timing struct {
	heartbeat, watchdog, ping, check, dial time.Duration
	backoff                                []time.Duration
}

var defaultTiming = timing{
	heartbeat: 15 * time.Second, watchdog: 35 * time.Second, ping: 10 * time.Second, check: 5 * time.Second, dial: 10 * time.Second,
	backoff: []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 15 * time.Second},
}

// link is one socket, from its dial to its end.
type link struct {
	conn     *websocket.Conn
	ended    chan struct{}
	err      error
	lastRead atomic.Int64

	// What the server pushes is held in backlog until the connection has been announced, so a reader sees EventUp
	// before anything that came after the hello it carries.
	pushMu  sync.Mutex
	live    bool
	dropped bool
	backlog []Message
}

// push hands a server event to the readers, or holds it until the link is live; a full queue drops it.
func (l *link) push(r *RT, msg Message) {
	l.pushMu.Lock()
	defer l.pushMu.Unlock()
	if l.dropped {
		return
	}
	if !l.live {
		l.backlog = append(l.backlog, msg)
		return
	}
	select {
	case r.Events <- msg:
	default:
	}
}

// goLive lets the held events through, in order.
func (l *link) goLive(r *RT) {
	l.pushMu.Lock()
	defer l.pushMu.Unlock()
	l.live = true
	for _, msg := range l.backlog {
		select {
		case r.Events <- msg:
		default:
		}
	}
	l.backlog = nil
}

// status is the close code the socket ended with, or -1; it says nothing until the socket has ended.
func (r *RT) status(l *link) websocket.StatusCode {
	r.mu.Lock()
	defer r.mu.Unlock()
	return websocket.CloseStatus(l.err)
}

// abandon closes a socket that never became the connection.
func (l *link) abandon() {
	l.pushMu.Lock()
	l.dropped, l.backlog = true, nil
	l.pushMu.Unlock()
	l.conn.CloseNow()
}

// RT is the realtime connection. It outlives its sockets: when one drops it dials another, says hello again, and
// tells whoever reads Events with EventDown and EventUp.
type RT struct {
	client *Client
	t      timing

	mu      sync.Mutex
	cur     *link
	nextRid int
	pending map[int]chan Message
	closed  bool
	err     error

	Events chan Message
	done   chan struct{}
	stop   chan struct{}
}

// Dial opens the socket and says hello. A server that does not know the token answers with ErrRejected.
func Dial(ctx context.Context, c *Client) (*RT, Hello, error) {
	r := &RT{client: c, t: defaultTiming, pending: map[int]chan Message{}, Events: make(chan Message, 256), done: make(chan struct{}), stop: make(chan struct{})}
	l, reply, err := r.connect(ctx)
	if err != nil {
		return nil, Hello{}, err
	}
	var hello Hello
	if err := reply.Decode(&hello); err != nil {
		l.abandon()
		return nil, hello, err
	}
	l.goLive(r)
	go r.run(l)
	return r, hello, nil
}

func (r *RT) socketOptions() *websocket.DialOptions {
	c := r.client
	httpClient := &http.Client{Transport: c.HTTP.Transport}
	if tr, ok := c.HTTP.Transport.(*http.Transport); ok && tr.TLSClientConfig != nil {
		httpClient.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: tr.TLSClientConfig.InsecureSkipVerify}} //nolint:gosec
	}
	header := http.Header{}
	if c.Password != "" {
		header.Set("X-Harmony-Password", c.Password)
	}
	return &websocket.DialOptions{HTTPClient: httpClient, HTTPHeader: header}
}

// connect dials, says hello and, when the server accepts, makes the socket the one requests go to. Its events are held back until goLive.
func (r *RT) connect(ctx context.Context) (*link, Message, error) {
	wsURL, err := r.client.WebSocketURL()
	if err != nil {
		return nil, Message{}, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, r.t.dial)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, wsURL, r.socketOptions())
	if err != nil {
		return nil, Message{}, r.client.unreachable(err)
	}
	conn.SetReadLimit(32 << 20)
	l := &link{conn: conn, ended: make(chan struct{})}
	l.lastRead.Store(time.Now().UnixNano())
	go r.readLoop(l)

	reply, err := r.requestOn(dialCtx, l, map[string]any{"type": "hello", "token": r.client.Token})
	switch {
	case err != nil:
		l.abandon()
		<-l.ended
		if r.status(l) == closeRejected {
			err = ErrRejected
		}
		return nil, reply, err
	case reply.Type != "hello-ok":
		l.abandon()
		if reply.Type == "hello-failed" {
			return nil, reply, ErrRejected
		}
		return nil, reply, fmt.Errorf("the server did not accept the session (%s)", reply.Type)
	}
	r.mu.Lock()
	r.cur = l
	r.mu.Unlock()
	return l, reply, nil
}

func (r *RT) readLoop(l *link) {
	for {
		_, data, err := l.conn.Read(context.Background())
		if err != nil {
			r.mu.Lock()
			l.err = err
			r.err = err
			if r.cur == l {
				r.cur = nil
			}
			for rid, ch := range r.pending {
				close(ch)
				delete(r.pending, rid)
			}
			r.mu.Unlock()
			close(l.ended)
			return
		}
		l.lastRead.Store(time.Now().UnixNano())
		msg := Message{Raw: data}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.Rid != 0 {
			r.mu.Lock()
			ch := r.pending[msg.Rid]
			delete(r.pending, msg.Rid)
			r.mu.Unlock()
			if ch != nil {
				ch <- msg
				continue
			}
		}
		l.push(r, msg)
	}
}

// emit puts a control event on Events, waiting for room; it gives up when the connection is closed.
func (r *RT) emit(typ string, raw json.RawMessage) {
	select {
	case r.Events <- Message{Type: typ, Raw: raw}:
	case <-r.stop:
	}
}

// run keeps a connection up for as long as the server lets it: it watches the socket, and when it ends dials again.
func (r *RT) run(l *link) {
	defer close(r.done)
	defer close(r.Events)
	for {
		go r.watch(l)
		<-l.ended
		if r.isClosed() {
			return
		}
		switch r.status(l) {
		case closeForbid:
			r.emit(EventClosed, nil)
			return
		case closeRejected:
			if !r.rejected() {
				return
			}
			next, reply, err := r.redial(true)
			if err != nil {
				return
			}
			l = r.announce(next, reply)
			continue
		}
		r.emit(EventDown, nil)
		next, reply, err := r.redial(false)
		if err != nil {
			return
		}
		l = r.announce(next, reply)
	}
}

// announce tells the readers the connection is back and lets the new socket's events follow.
func (r *RT) announce(l *link, reply Message) *link {
	r.emit(EventUp, reply.Raw)
	l.goLive(r)
	return l
}

// rejected tells the readers the session is no good and says whether a new one was made.
func (r *RT) rejected() bool {
	r.emit(EventRejected, nil)
	if r.client.Relogin == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return r.client.Relogin(ctx)
}

// redial tries again, slower and slower, until a socket says hello; an error means the session is over for good.
func (r *RT) redial(immediate bool) (*link, Message, error) {
	for attempt := 0; ; attempt++ {
		if !immediate || attempt > 0 {
			base := r.t.backoff[min(attempt, len(r.t.backoff)-1)]
			delay := base + time.Duration(rand.Int64N(int64(base/2)+1))
			select {
			case <-time.After(delay):
			case <-r.stop:
				return nil, Message{}, ErrNotConnected
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			select {
			case <-r.stop:
				cancel()
			case <-ctx.Done():
			}
		}()
		l, reply, err := r.connect(ctx)
		cancel()
		switch {
		case err == nil:
			return l, reply, nil
		case errors.Is(err, ErrRejected):
			if !r.rejected() {
				return nil, Message{}, err
			}
			immediate, attempt = true, -1
		case r.isClosed():
			return nil, Message{}, ErrNotConnected
		}
	}
}

// watch asks the server whether it is still there, and drops a socket that has said nothing for too long.
func (r *RT) watch(l *link) {
	tick := time.NewTicker(r.t.check)
	defer tick.Stop()
	lastPing := time.Now()
	for {
		select {
		case <-l.ended:
			return
		case <-tick.C:
		}
		if time.Since(time.Unix(0, l.lastRead.Load())) > r.t.watchdog {
			l.conn.CloseNow()
			return
		}
		if time.Since(lastPing) >= r.t.heartbeat {
			lastPing = time.Now()
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), r.t.ping)
				defer cancel()
				_, _ = r.requestOn(ctx, l, map[string]any{"type": "ping"})
			}()
		}
	}
}

func (r *RT) isClosed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closed
}

func (r *RT) request(ctx context.Context, fields map[string]any) (Message, error) {
	r.mu.Lock()
	l := r.cur
	r.mu.Unlock()
	if l == nil {
		return Message{}, ErrNotConnected
	}
	return r.requestOn(ctx, l, fields)
}

func (r *RT) requestOn(ctx context.Context, l *link, fields map[string]any) (Message, error) {
	r.mu.Lock()
	r.nextRid++
	rid := r.nextRid
	ch := make(chan Message, 1)
	r.pending[rid] = ch
	r.mu.Unlock()

	fields["rid"] = rid
	raw, err := json.Marshal(fields)
	if err == nil {
		err = l.conn.Write(ctx, websocket.MessageText, raw)
	}
	if err != nil {
		r.mu.Lock()
		delete(r.pending, rid)
		r.mu.Unlock()
		return Message{}, err
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return Message{}, errors.New("the connection to the server was lost")
		}
		return msg, nil
	case <-ctx.Done():
		r.mu.Lock()
		delete(r.pending, rid)
		r.mu.Unlock()
		return Message{}, ctx.Err()
	}
}

// Request sends one realtime request and waits for its answer.
func (r *RT) Request(ctx context.Context, typ string, fields map[string]any) (Message, error) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["type"] = typ
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	msg, err := r.request(ctx, fields)
	if err != nil {
		return msg, err
	}
	if msg.Type == "voice:error" || msg.Type == "error" || msg.Type == "hello-failed" {
		e := ReplyError{Request: typ}
		_ = msg.Decode(&e)
		return msg, &e
	}
	return msg, nil
}

// Connected is whether a socket that has said hello is up.
func (r *RT) Connected() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cur != nil
}

// Done is closed when the connection is over for good: closed, rejected or hung up on.
func (r *RT) Done() <-chan struct{} { return r.done }

// Err is why the last socket ended.
func (r *RT) Err() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err
}

// Close ends the connection and stops it coming back.
func (r *RT) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	l := r.cur
	r.mu.Unlock()
	close(r.stop)
	if l != nil {
		_ = l.conn.Close(websocket.StatusNormalClosure, "bye")
	}
}
