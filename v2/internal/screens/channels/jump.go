package channels

import (
	"math"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	flashFor   = 1600 * time.Millisecond
	flashHold  = 960 * time.Millisecond
	flashAlpha = 0.22
	jumpRate   = 14
	jumpDone   = 0.5
	starSize   = 12.8
	starTop    = 4.8
	starRight  = 8
	pinBar     = 3
)

// jumpState is where the log is being taken: the message it has to land on, and the one that flashes once it has.
type jumpState struct {
	want    int
	landing int
	flash   int
	flashAt time.Time
}

// goTo opens a text channel at one of its messages, loading what lies between it and the newest message when it is far back.
func (s *Screen) goTo(channel, id int) {
	f := &s.chat.find
	if s.chat.dm {
		s.dm.reveal = id
		return
	}
	if channel < 0 {
		s.revealHere(channel, id)
		return
	}
	if !s.isTextChannel(channel) {
		s.say(f.c.T("stars.channel_gone"))
		return
	}
	s.openText(channel)
	f.jump = jumpState{}
	c := f.c
	s.Session.Chat().Reveal(channel, id, func(found bool) {
		c.Post(func() {
			if found && s.chat.channel == channel {
				f.jump.want = id
				return
			}
			if !found {
				s.say(c.T("app.that_message_is_no_longer"))
			}
		})
	})
}

func (s *Screen) isTextChannel(id int) bool {
	for _, ch := range s.Session.State().Channels {
		if ch.ID == id {
			return ch.Kind == "text"
		}
	}
	return false
}

// landJump scrolls the log so that the message being gone to is in the middle, easing there, and starts its flash.
func (s *Screen) landJump(c *widget.Context, log geom.Rect, rows []row, total float32) {
	st := &s.chat
	j := &st.find.jump
	if j.want != 0 {
		for i := range rows {
			if rows[i].entry.Msg.ID == j.want {
				j.landing, j.flash, j.flashAt, j.want = j.want, j.want, time.Now(), 0
				break
			}
		}
	}
	if j.landing != 0 {
		if c.In.Wheel != 0 {
			j.landing = 0
		}
		for i := range rows {
			if rows[i].entry.Msg.ID != j.landing {
				continue
			}
			target := total - rows[i].top - rows[i].height/2 - log.H/2
			target = min(max(target, 0), max(0, total-log.H))
			step := 1 - float32(math.Exp(-float64(c.Dt)*jumpRate))
			st.offset += (target - st.offset) * step
			if float32(math.Abs(float64(target-st.offset))) < jumpDone {
				st.offset, j.landing = target, 0
			} else {
				redraw.Request()
			}
		}
	}
	if j.flash != 0 {
		if time.Since(j.flashAt) >= flashFor {
			j.flash = 0
		} else {
			redraw.Request()
		}
	}
}

// drawRowMarks paints what a message's row shows beside its words: the bar of a pin, the star, and the flash of a jump.
func (s *Screen) drawRowMarks(c *widget.Context, bounds geom.Rect, msg *hclient.ChatMessage) {
	f := &s.chat.find
	if f.jump.flash == msg.ID {
		age := time.Since(f.jump.flashAt)
		alpha := float32(flashAlpha)
		if age > flashHold {
			left := 1 - float32(age-flashHold)/float32(flashFor-flashHold)
			alpha *= max(0, left)
		}
		c.Paint.Fill(bounds, rowRadiusMsg, theme.WithAlpha(c.Theme.Accent, alpha))
	}
	if msg.Pinned {
		c.Paint.Fill(geom.Rect{X: bounds.X, Y: bounds.Y, W: pinBar, H: bounds.H}, 0, c.Theme.Accent)
	}
	if f.starred(s, msg.ID) {
		c.Paint.Icon("star", geom.Rect{X: bounds.Right() - starRight - starSize, Y: bounds.Y + starTop, W: starSize, H: starSize}, starInk)
	}
}
