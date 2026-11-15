// Package profilecard is the small card that opens beside a person's name or picture: their banner, picture, badges, when they
// joined and the roles they hold, with a button to write to them and, for those who may, to change their roles.
package profilecard

import (
	"context"
	"image/color"
	"slices"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	cardWidth      = 320
	cardRadius     = 12
	cardGap        = 8
	cardShadowY    = 10
	cardShadowBlur = 30
	cardShadowA    = 115
	rolesTimeout   = 10 * time.Second

	bannerHeight = 99.2
	bodyPadTop   = 51.2
	bodyPadSide  = 16
	bodyPadEnd   = 14.4
	bodyGap      = 4
	faceLeft     = 14.4
	faceTop      = 57.6
	faceInner    = 69.16
	faceRing     = 3.91
	faceFont     = 36.4
	statusSize   = 16.9
	statusRing   = 2.61
	statusX      = 65.6
	statusY      = 63.8
	nameSize     = 18.4
	smallSize    = 13.6
	smallLine    = 20.4
	actionsInset = 8
	actionW      = 43.7
	actionH      = 31.7
	actionGap    = 5.6
	actionGlyph  = 19.7
	actionRadius = 8
	actionPlate  = 140
)

// Card is the profile card; the screen that shows it calls Draw every frame and Open when a name or picture is pressed.
type Card struct {
	Session *app.Session
	// Message opens a private conversation with the person, when CanMessage says there can be one.
	Message    func(c *widget.Context, userID int)
	CanMessage func() bool
	// Manage opens the Members page on the person, when CanManage says the signed-in account may.
	Manage    func(c *widget.Context, userID int)
	CanManage func(userID int) bool

	open   bool
	fresh  bool
	user   int
	anchor geom.Rect
	adding bool
	tip    int
	tipAt  geom.Rect
	note   string
	box    geom.Rect
}

// Open shows the card for a person beside the rectangle that was pressed; pressing the same one again puts it away.
func (k *Card) Open(userID int, anchor geom.Rect) {
	if k.open && k.user == userID && k.anchor == anchor {
		k.Close()
		return
	}
	k.open, k.fresh, k.user, k.anchor, k.adding, k.note, k.tip = true, true, userID, anchor, false, "", 0
}

func (k *Card) Close() { k.open = false }

func (k *Card) IsOpen() bool { return k.open }

// Draw shows the card over everything while it is open.
func (k *Card) Draw(c *widget.Context) {
	if !k.open {
		return
	}
	c.Overlay(func() { k.paint(c) })
}

func (k *Card) paint(c *widget.Context) {
	if c.People == nil {
		return
	}
	e := c.People.ByID(k.user)
	if e == nil {
		k.open = false
		return
	}
	st := k.Session.State()
	v := k.view(c, st, e)
	width := min(cardWidth, c.Viewport.W-2*cardGap)
	height := v.height(c, width)
	k.box = k.place(c, width, height)
	c.Popup(k.box)
	c.Layer(k)
	inside := k.box.Contains(c.In.MouseX, c.In.MouseY)
	if !k.fresh && (c.EscapeFor(k) || (c.In.Pressed || c.In.RightPressed) && !inside) {
		k.open = false
		return
	}
	k.fresh = false
	if inside && c.In.Pressed {
		c.Claim()
	}
	v.draw(c, k.box)
}

// place puts the card beside what was pressed, on the side with room, kept inside the window.
func (k *Card) place(c *widget.Context, width, height float32) geom.Rect {
	a := k.anchor
	x := a.Right() + cardGap
	if a.X > c.Viewport.W/2 {
		x = a.X - width - cardGap
	}
	if x+width > c.Viewport.W-cardGap || x < cardGap {
		x = min(max(cardGap, a.X), c.Viewport.W-width-cardGap)
	}
	y := min(max(cardGap, a.Y), c.Viewport.H-height-cardGap)
	return geom.Rect{X: x, Y: y, W: width, H: height}
}

// view is what one frame of the card holds, gathered once.
type view struct {
	k       *Card
	e       *people.Entry
	st      *app.State
	mine    bool
	above   bool
	held    []hclient.Role
	addable []hclient.Role
	badges  []hclient.Badge
	online  bool
	status  string
	actor   hclient.Actor
}

func (k *Card) view(c *widget.Context, st *app.State, e *people.Entry) *view {
	v := &view{k: k, e: e, st: st, mine: e.ID == st.Me.ID, actor: st.Actor}
	v.held = c.People.RolesOf(e)
	target := hclient.ActorOf(hclient.User{Role: e.Role, Roles: e.Roles}, st.Roles)
	v.above = !v.mine && (st.Actor.Owner || st.Actor.Outranks(target))
	if v.above {
		for _, r := range st.Roles {
			if !slices.ContainsFunc(v.held, func(h hclient.Role) bool { return h.ID == r.ID }) && st.Actor.CanAssign(r) {
				v.addable = append(v.addable, r)
			}
		}
	}
	for _, id := range e.Badges {
		if i := slices.IndexFunc(st.Badges, func(b hclient.Badge) bool { return b.ID == id }); i >= 0 {
			v.badges = append(v.badges, st.Badges[i])
		}
	}
	v.online = slices.Contains(st.Presence.Online, e.ID)
	if v.online {
		v.status = st.Presence.Statuses[e.ID]
	}
	return v
}

func (k *Card) setRoles(c *widget.Context, id int, ids []int) {
	client := k.Session.Client()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), rolesTimeout)
		defer cancel()
		_, err := client.SetAccountRoles(ctx, id, ids)
		c.Post(func() {
			k.adding = false
			if err != nil {
				k.note = err.Error()
			} else {
				k.note = ""
			}
		})
	}()
}

func statusColor(c *widget.Context, online bool, status string) color.RGBA {
	switch {
	case !online:
		return c.Theme.Muted
	case status == "idle":
		return theme.StatusIdle
	case status == "dnd":
		return theme.StatusDoNotDisturb
	}
	return theme.StatusOnline
}
