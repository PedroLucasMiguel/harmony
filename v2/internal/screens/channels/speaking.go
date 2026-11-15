package channels

import (
	"sync/atomic"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/ui/redraw"
)

// speakingWatch asks for a frame when somebody starts or stops speaking, so a call does not redraw the window on a timer.
type speakingWatch struct {
	wanted  atomic.Bool
	running atomic.Bool
}

// follow keeps the watch going while joined is true; call it from every frame that shows the call.
func (w *speakingWatch) follow(session *app.Session, joined bool) {
	w.wanted.Store(joined)
	w.start(session)
}

func (w *speakingWatch) start(session *app.Session) {
	if w.wanted.Load() && w.running.CompareAndSwap(false, true) {
		go w.run(session)
	}
}

func (w *speakingWatch) run(session *app.Session) {
	ticker := time.NewTicker(speakingPoll)
	defer ticker.Stop()
	last := session.Speaking(speakingLevel)
	for w.wanted.Load() {
		select {
		case <-session.Done():
			w.running.Store(false)
			return
		case <-ticker.C:
		}
		if now := session.Speaking(speakingLevel); now != last {
			last = now
			redraw.Request()
		}
	}
	w.running.Store(false)
	w.start(session)
}
