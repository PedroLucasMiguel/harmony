package desktop

import (
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/idle"
)

const (
	idleAfter = 5 * time.Minute
	idlePoll  = 5 * time.Second
	awayPoll  = time.Second
)

// watchIdle tells the server when the computer has been left alone for five minutes, and when it is touched again (looked at every second while away, so that coming back shows at once). Somebody in a voice channel is not idle. It
// stops when stop is closed.
func watchIdle(s *app.Session, stop chan struct{}, told func(away bool)) {
	wait := idlePoll
	for {
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
		since, ok := idle.Since()
		if !ok {
			return
		}
		idle := since >= idleAfter
		away := idle && !s.InVoice()
		s.SetAway(away)
		if told != nil {
			told(idle)
		}
		wait = idlePoll
		if away {
			wait = awayPoll
		}
	}
}
