package video

import (
	"io"
	"sync"
	"time"
)

// auQueue holds the access units a capture has made that nobody has taken yet: when it is full the oldest is dropped,
// so a slow reader sees the latest picture rather than an ever later one. Buffers are reused, so the steady state
// allocates nothing. onDrop, when set before the first push, is called after each drop: the pictures after a dropped one
// cannot be decoded until the next key frame.
type auQueue struct {
	mu     sync.Mutex
	wake   chan struct{}
	items  [][]byte
	free   [][]byte
	held   []byte
	limit  int
	onDrop func()
	err    error
	closed bool
}

func newAUQueue(limit int) *auQueue {
	return &auQueue{limit: limit, wake: make(chan struct{}, 1)}
}

func (q *auQueue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// push copies au in; it is called from the encoder's goroutine and never waits.
func (q *auQueue) push(au []byte) {
	q.mu.Lock()
	if q.closed || q.err != nil {
		q.mu.Unlock()
		return
	}
	dropped := len(q.items) == q.limit
	if dropped {
		q.free = append(q.free, q.items[0][:0])
		copy(q.items, q.items[1:])
		q.items = q.items[:len(q.items)-1]
	}
	var buf []byte
	if n := len(q.free); n > 0 {
		buf, q.free = q.free[n-1], q.free[:n-1]
	}
	q.items = append(q.items, append(buf, au...))
	q.mu.Unlock()
	q.signal()
	if dropped && q.onDrop != nil {
		q.onDrop()
	}
}

// fail ends the queue with the reason the capture stopped; what is queued can still be taken first.
func (q *auQueue) fail(err error) {
	if err == nil {
		err = io.EOF
	}
	q.mu.Lock()
	if q.err == nil {
		q.err = err
	}
	q.mu.Unlock()
	q.signal()
}

// close makes next return at once, with io.EOF.
func (q *auQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.signal()
}

// next waits up to wait (forever when 0) for the oldest unit. It is valid until the next call. ok is false, with a nil
// error, when the wait ran out.
func (q *auQueue) next(wait time.Duration) (au []byte, ok bool, err error) {
	var timeout <-chan time.Time
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		timeout = timer.C
	}
	for {
		q.mu.Lock()
		if q.held != nil {
			q.free = append(q.free, q.held[:0])
			q.held = nil
		}
		switch {
		case q.closed:
			q.mu.Unlock()
			return nil, false, io.EOF
		case len(q.items) > 0:
			q.held = q.items[0]
			copy(q.items, q.items[1:])
			q.items = q.items[:len(q.items)-1]
			more := len(q.items) > 0
			q.mu.Unlock()
			if more {
				q.signal()
			}
			return q.held, true, nil
		case q.err != nil:
			err = q.err
			q.mu.Unlock()
			q.signal()
			return nil, false, err
		}
		q.mu.Unlock()
		select {
		case <-q.wake:
		case <-timeout:
			return nil, false, nil
		}
	}
}
