package channels

import (
	"context"
	"image/color"
	"slices"
	"strconv"
	"strings"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	notifiedWidth   = 300
	notifiedMaxList = 288
	notifiedHeadPad = 8.8
	notifiedHeadY   = 8.8
	notifiedListPad = 4
	notifiedRowPadY = 4.8
	notifiedRowPadX = 6.4
	notifiedRowGap  = 8
	notifiedFace    = 20
	notifiedOffDim  = 0.55
	notifiedTimeout = 10 * time.Second
	notifiedHover   = 0.18
)

var (
	notifiedTitle = paint.TextStyle{Size: 14, Weight: paint.Bold}
	notifiedCount = paint.TextStyle{Size: 12.48, Weight: paint.Regular}
	notifiedName  = paint.TextStyle{Size: 14, Weight: paint.Regular}
)

// chips tells how an @name or #channel in a message is drawn: a person by display name, a role in its colour, @everyone, and a channel that can be opened.
func (s *Screen) chips(m model) widget.Chips {
	me := m.state.Me
	return func(written string) widget.Chip {
		name := written[1:]
		if written[0] == '#' {
			for _, ch := range m.channels {
				if (ch.Kind == "text" || ch.Kind == "forum") && channelHandle(ch.Name) == name {
					return widget.Chip{Known: true, Text: "#" + ch.Name, Channel: ch.ID}
				}
			}
			return widget.Chip{}
		}
		if name == everyoneHandle {
			return widget.Chip{Known: true, Me: true, Text: "@everyone", Group: "everyone"}
		}
		for _, a := range m.state.Members {
			if strings.ToLower(a.Nickname) == name {
				return widget.Chip{Known: true, Me: a.ID == me.ID, Text: "@" + a.Name(), Person: a.ID}
			}
		}
		roles := slices.Clone(m.state.Roles)
		slices.SortStableFunc(roles, func(a, b hclient.Role) int { return a.Position - b.Position })
		for _, role := range roles {
			if roleHandle(role.Name) == name {
				colour, _ := parseHex(role.Color)
				return widget.Chip{Known: true, Me: slices.Contains(me.Roles, role.ID), Text: "@" + role.Name, Colour: colour, Group: "role:" + strconv.Itoa(role.ID)}
			}
		}
		return widget.Chip{}
	}
}

// notifiedList is the pop-up that says whom a message reached.
type notifiedList struct {
	open    bool
	fresh   bool
	title   string
	at      geom.Rect
	people  []notifiedPerson
	loading bool
	scroll  float32
}

type notifiedPerson struct {
	id     int
	name   string
	online bool
}

// chipPressed does what pressing a chip in a message does: a person shows their card, a channel opens, @everyone and a role show who they reached.
func (s *Screen) chipPressed(c *widget.Context, m model, id int, click widget.ChipClick) {
	chip := click.Chip
	switch {
	case chip.Person != 0 && c.OpenProfile != nil:
		c.OpenProfile(chip.Person, click.Rect)
	case chip.Channel != 0:
		for _, ch := range m.channels {
			if ch.ID == chip.Channel {
				s.pick(ch.ID, ch.Kind)
			}
		}
	case chip.Group != "":
		s.showNotified(c, m, id, click)
	}
}

func (s *Screen) showNotified(c *widget.Context, m model, id int, click widget.ChipClick) {
	n := &s.chat.notified
	*n = notifiedList{open: true, fresh: true, at: click.Rect, title: click.Chip.Text, loading: true}
	group := click.Chip.Group
	client := s.Session.Client()
	members := m.state.Members
	online := m.online
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), notifiedTimeout)
		defer cancel()
		answer, err := client.Notified(ctx, id)
		c.Post(func() {
			if !n.open || n.title != click.Chip.Text {
				return
			}
			n.loading = false
			if err != nil {
				n.open = false
				s.fail(err)
				return
			}
			role := -1
			if after, ok := strings.CutPrefix(group, "role:"); ok {
				role, _ = strconv.Atoi(after)
			}
			for _, uid := range answer.Reached {
				for _, a := range members {
					if a.ID == uid && (role < 0 || slices.Contains(a.Roles, role)) {
						n.people = append(n.people, notifiedPerson{id: a.ID, name: a.Name(), online: online[a.ID] != widget.Offline})
					}
				}
			}
			if len(n.people) == 1 && c.OpenProfile != nil {
				n.open = false
				c.OpenProfile(n.people[0].id, n.at)
				return
			}
			slices.SortStableFunc(n.people, func(a, b notifiedPerson) int {
				if a.online != b.online {
					if a.online {
						return -1
					}
					return 1
				}
				return strings.Compare(strings.ToLower(a.name), strings.ToLower(b.name))
			})
		})
	}()
}

// showNotifiedList draws the pop-up while it is open.
func (s *Screen) showNotifiedList(c *widget.Context) {
	if s.chat.notified.open {
		c.Overlay(func() { s.drawNotified(c) })
	}
}

func (s *Screen) drawNotified(c *widget.Context) {
	n := &s.chat.notified
	if n.loading {
		return
	}
	edge := c.Hairline()
	count := c.T("mention.nobody")
	if len(n.people) > 0 {
		count = c.T("mention.notified", "count", strconv.Itoa(len(n.people)))
	}
	rowH := float32(2*notifiedRowPadY + 21)
	head := float32(2*notifiedHeadY + 21)
	listH := min(float32(len(n.people))*rowH+2*notifiedListPad, notifiedMaxList)
	h := head + 2*edge
	if len(n.people) > 0 {
		h += listH + edge
	}
	w := min(notifiedWidth, c.Viewport.W-16)
	x := max(8, min(n.at.X, c.Viewport.W-w-8))
	y := n.at.Bottom() + 6
	if y+h > c.Viewport.H-8 {
		y = max(8, n.at.Y-h-6)
	}
	pop := geom.Rect{X: x, Y: y, W: w, H: h}
	c.Popup(pop)
	c.Layer(n)
	if !n.fresh && (c.EscapeFor(n) || c.In.Pressed && !pop.Contains(c.In.MouseX, c.In.MouseY)) {
		n.open = false
		return
	}
	n.fresh = false
	c.Paint.Shadow(pop, mentionRadius, mentionShadowY, mentionShadowBlr, color.RGBA{A: mentionShadowA})
	c.Paint.Fill(pop, mentionRadius, c.Theme.Surface)
	c.Paint.Stroke(pop, mentionRadius, edge, c.Theme.Border)
	c.Paint.PushClip(pop)
	ix := pop.X + edge + notifiedHeadPad
	cw := c.Paint.TextWidth(count, notifiedCount)
	c.Paint.Text(count, pop.Right()-edge-notifiedHeadPad-cw, pop.Y+edge+notifiedHeadY+(21-18.72)/2, 18.72, notifiedCount, c.Theme.Muted)
	c.Paint.TextIn(geom.Rect{X: ix, Y: pop.Y, W: max(0, pop.W-2*notifiedHeadPad-cw-8), H: head}, n.title, ix, pop.Y+edge+notifiedHeadY, 21, notifiedTitle, c.Theme.Text)
	if len(n.people) > 0 {
		top := pop.Y + edge + head
		c.Paint.Fill(geom.Rect{X: pop.X + edge, Y: top, W: pop.W - 2*edge, H: edge}, 0, c.Theme.Border)
		list := geom.Rect{X: pop.X + edge, Y: top + edge, W: pop.W - 2*edge, H: listH}
		total := float32(len(n.people))*rowH + 2*notifiedListPad
		if c.Hovered(list) {
			n.scroll -= c.In.Wheel * rowH
		}
		n.scroll = min(max(n.scroll, 0), max(0, total-list.H))
		c.Paint.PushClip(list)
		for i, p := range n.people {
			row := geom.Rect{X: list.X + notifiedListPad, Y: list.Y + notifiedListPad + float32(i)*rowH - n.scroll, W: list.W - 2*notifiedListPad, H: rowH}
			if row.Bottom() < list.Y || row.Y > list.Bottom() {
				continue
			}
			ink := c.Theme.Text
			if !p.online {
				ink = theme.WithAlpha(ink, notifiedOffDim)
			}
			if c.Hovered(row) {
				c.SetCursor(rl.MouseCursorPointingHand)
				c.Paint.Fill(row, mentionRowRadius, theme.WithAlpha(c.Theme.Accent, notifiedHover))
				if c.Clicked(row) {
					c.Claim()
					n.open = false
					if c.OpenProfile != nil {
						c.OpenProfile(p.id, row)
					}
				}
			}
			fx := row.X + notifiedRowPadX
			widget.Avatar{Name: p.name, ID: p.id, Size: notifiedFace, Font: 8, Dim: !p.online}.Draw(c, geom.Rect{X: fx, Y: row.Y + (row.H-notifiedFace)/2, W: notifiedFace, H: notifiedFace})
			tx := fx + notifiedFace + notifiedRowGap
			c.Paint.TextIn(geom.Rect{X: tx, Y: row.Y, W: max(0, row.Right()-notifiedRowPadX-tx), H: row.H}, p.name, tx, row.Y+notifiedRowPadY, 21, notifiedName, ink)
		}
		c.Paint.PopClip()
	}
	c.Paint.PopClip()
}
