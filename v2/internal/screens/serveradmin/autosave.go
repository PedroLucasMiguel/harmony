package serveradmin

import (
	"context"
	"time"

	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	saveDelay   = 600 * time.Millisecond
	saveTimeout = 30 * time.Second
)

// noteKind is what the footer says about the last change.
type noteKind int

const (
	noteNone noteKind = iota
	noteSaving
	noteSaved
	noteFailed
)

type note struct {
	kind noteKind
	err  string
}

func (n note) text(c *widget.Context) (string, bool) {
	switch n.kind {
	case noteSaving:
		return c.T("server_admin.saving"), false
	case noteSaved:
		return c.T("server_admin.saved_live"), false
	case noteFailed:
		return n.err, true
	}
	return "", false
}

func (d *Dialog) report(kind noteKind, err string) {
	d.note = note{kind: kind, err: err}
	redraw.Request()
}

// autosave sends what a page holds as it changes: one send at a time, and what changed meanwhile goes in the next. plan runs on the
// interface's thread and reads the page; it returns nil when there is nothing to send, else the call to make.
type autosave struct {
	d       *Dialog
	plan    func() func(context.Context) error
	timer   *time.Timer
	pending bool
	running bool
	again   bool
}

// newAutosave makes a sender the dialog flushes when it closes.
func (d *Dialog) newAutosave(plan func() func(context.Context) error) *autosave {
	a := &autosave{d: d, plan: plan}
	d.saves = append(d.saves, a)
	return a
}

// touch says something changed; it is sent after the delay without another change, or at once with flush.
func (a *autosave) touch(delay time.Duration) {
	if a.timer != nil {
		a.timer.Stop()
	}
	a.pending = true
	c := a.d.ctx
	a.timer = time.AfterFunc(delay, func() { c.Post(a.fire) })
}

// Touch is touch with the usual delay.
func (a *autosave) Touch() { a.touch(saveDelay) }

// flush sends at once what is waiting.
func (a *autosave) flush() {
	if !a.pending {
		return
	}
	a.timer.Stop()
	a.fire()
}

// cancel drops what is waiting: the thing it was for is gone.
func (a *autosave) cancel() {
	if a.timer != nil {
		a.timer.Stop()
	}
	a.pending = false
}

func (a *autosave) fire() {
	if !a.pending && !a.again {
		return
	}
	a.pending = false
	if a.running {
		a.again = true
		return
	}
	job := a.plan()
	if job == nil {
		a.d.report(noteNone, "")
		return
	}
	a.running = true
	a.again = false
	a.d.report(noteSaving, "")
	c := a.d.ctx
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		err := job(ctx)
		c.Post(func() { a.done(err) })
	}()
}

func (a *autosave) done(err error) {
	a.running = false
	switch {
	case err != nil:
		a.again = false
		a.d.report(noteFailed, err.Error())
	case a.again || a.pending:
		a.fire()
	default:
		a.d.report(noteSaved, "")
	}
}
