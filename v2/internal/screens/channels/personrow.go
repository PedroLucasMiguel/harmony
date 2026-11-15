package channels

import (
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	lockSize      = 12
	lockLine      = 18
	lockAlpha     = 0.7
	tipDelay      = 700 * time.Millisecond
	dragGhostPad  = 8
	dragGhostGap  = 14
	dragGhostFont = 13.6
	dragIntoAlpha = 0.22
	dragGhostFill = 0.92
)

type lockState uint8

const (
	notLocked lockState = iota
	lockedChannel
	openedChannel
)

// lockTag says whether a channel asks for a password: "locked", or "unlocked" for those who are let in without one.
func (s *Screen) lockTag(ch hclient.Channel, m model) lockState {
	switch {
	case !ch.Locked:
		return notLocked
	case m.state.Actor.Admin || s.Session.Unlocked(ch.ID):
		return openedChannel
	}
	return lockedChannel
}

// drawLockTag writes the word at the right edge of a row and returns the width it took.
func drawLockTag(c *widget.Context, state lockState, right float32, row geom.Rect) float32 {
	text := c.T("app.locked")
	if state == openedChannel {
		text = c.T("app.unlocked")
	}
	style := paint.TextStyle{Size: lockSize, Weight: paint.Regular}
	width := c.Paint.TextWidth(text, style)
	c.Paint.Text(text, right-width, row.Y+(row.H-lockLine)/2, lockLine, style, theme.WithAlpha(c.Theme.Text, lockAlpha))
	return width
}

// personRow is what somebody in a voice channel's list answers to: a right-click opens their menu, a press on a person an admin may
// move starts a drag to another channel, and a click opens their card.
func (s *Screen) personRow(c *widget.Context, r geom.Rect, channelID int, member hclient.Member, m model) {
	self := member.Mid == m.state.MyMid && channelID == m.state.Joined
	canMove := !self && m.state.Actor.Can("users.kick")
	if !c.Hovered(r) {
		return
	}
	tip := c.T("app.right_click_for_volume_and")
	if canMove {
		tip = c.T("app.drag_to_another_voice_channel")
	}
	if !self {
		s.tip.Show(c, r, tip, tipDelay)
	}
	if c.In.RightPressed && !self {
		c.Claim()
		s.openPeerMenu(c, channelID, member.Mid)
		return
	}
	if !c.In.Pressed || c.Claimed() {
		return
	}
	c.Claim()
	if canMove {
		s.pdrag = personDrag{phase: dragPressed, user: member.UserID, from: channelID, row: r, startX: c.In.MouseX, startY: c.In.MouseY, name: displayName(c, member.UserID, member.Nickname)}
		return
	}
	if c.OpenProfile != nil {
		c.OpenProfile(member.UserID, r)
	}
}

// personDrag is somebody being dragged to another voice channel; a press that has not moved is still a click.
type personDrag struct {
	phase  dragPhase
	user   int
	from   int
	row    geom.Rect
	startX float32
	startY float32
	name   string
}

// updatePersonDrag runs once a frame after the channel list is drawn: it follows the drag, lights the channel it would land in, and
// on release moves the person there.
func (s *Screen) updatePersonDrag(c *widget.Context) {
	d := &s.pdrag
	if d.phase == dragIdle {
		return
	}
	if d.phase == dragPressed {
		if !c.In.Down || c.In.Released {
			click := *d
			*d = personDrag{}
			if c.OpenProfile != nil {
				c.OpenProfile(click.user, click.row)
			}
			return
		}
		dx, dy := c.In.MouseX-d.startX, c.In.MouseY-d.startY
		if dx*dx+dy*dy < mvDragStart*mvDragStart {
			return
		}
		d.phase = dragMoving
	}
	if c.In.Escape {
		*d = personDrag{}
		return
	}
	target, lit := s.voiceDropTarget(c, d.from)
	if target != 0 {
		c.Paint.Fill(lit, rowRadius, theme.WithAlpha(c.Theme.Accent, dragIntoAlpha))
	}
	s.drawDragGhost(c, d.name)
	if c.In.Released || !c.In.Down {
		user := d.user
		*d = personDrag{}
		if target != 0 {
			s.movePerson(user, target)
		}
	}
}

// voiceDropTarget is the voice channel under the pointer other than the one the person is in, and the row to light.
func (s *Screen) voiceDropTarget(c *widget.Context, from int) (int, geom.Rect) {
	for _, slot := range s.admin.drag.slots {
		if slot.group || slot.id == from || !slot.hit.Contains(c.In.MouseX, c.In.MouseY) {
			continue
		}
		for _, ch := range s.seen.channels {
			if ch.ID == slot.id && ch.Kind == "voice" {
				return ch.ID, slot.row
			}
		}
	}
	return 0, geom.Rect{}
}

func (s *Screen) drawDragGhost(c *widget.Context, name string) {
	style := paint.TextStyle{Size: dragGhostFont, Weight: paint.Medium}
	w := c.Paint.TextWidth(name, style) + 2*dragGhostPad
	box := geom.Rect{X: c.In.MouseX + dragGhostGap, Y: c.In.MouseY + dragGhostGap, W: w, H: dragGhostFont*1.5 + 2*dragGhostPad/2}
	c.Overlay(func() {
		c.Paint.Fill(box, rowRadius, theme.WithAlpha(c.Theme.Surface2, dragGhostFill))
		c.Paint.Stroke(box, rowRadius, c.Hairline(), c.Theme.BorderStrong)
		c.Paint.Text(name, box.X+dragGhostPad, box.Y+dragGhostPad/2, dragGhostFont*1.5, style, c.Theme.Text)
	})
}
