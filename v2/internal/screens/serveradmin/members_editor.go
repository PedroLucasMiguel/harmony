package serveradmin

import (
	"context"
	"image/color"
	"slices"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	subjectGap       = 8
	subjectAvatar    = 15.1
	subjectFont      = 10.08
	subjectAvatarGap = 3.5
	subjectSize      = 16.8
	noteGap          = 3.2
	noteSize         = 12
	actionsGap       = 8
	actionsTop       = 4.8
	fieldMargin      = 9.6
	sendTimeout      = 30 * time.Second
)

var (
	subjectFace = paint.TextStyle{Size: subjectSize, Weight: paint.Bold}
	noteFace    = paint.TextStyle{Size: noteSize, Weight: paint.Regular}
)

func roleColor(c *widget.Context, r hclient.Role) color.RGBA {
	if col, ok := people.ParseColor(r.Color); ok {
		return col
	}
	return c.Theme.Muted
}

func chipsOf(c *widget.Context, st *app.State, a hclient.Account) []widget.RoleChip {
	var chips []widget.RoleChip
	for _, r := range hclient.RolesOf(userOf(a), st.Roles) {
		chips = append(chips, widget.RoleChip{Name: r.Name, Color: roleColor(c, r)})
	}
	return chips
}

func accountOf(st *app.State, id int) (hclient.Account, bool) {
	for _, a := range st.Members {
		if a.ID == id {
			return a, true
		}
	}
	return hclient.Account{}, false
}

// send makes a call to the server off the interface's thread; when it is done the page is made again from what the session holds.
func (p *membersPage) send(call func(ctx context.Context) error) {
	c := p.d.ctx
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
		defer cancel()
		err := call(ctx)
		c.Post(func() { p.done(err) })
	}()
}

func (p *membersPage) done(err error) {
	p.stale, p.problem = true, ""
	if err != nil {
		p.problem = err.Error()
	}
	redraw.Request()
}

func toggled(held []int, id int, on bool) []int {
	next := slices.DeleteFunc(slices.Clone(held), func(x int) bool { return x == id })
	if on {
		next = append(next, id)
	}
	return next
}

func (p *membersPage) editor(c *widget.Context, st *app.State) {
	user, ok := accountOf(st, p.selected)
	if !ok {
		p.split.Editor = nil
		return
	}
	actor, target := st.Actor, hclient.ActorOf(userOf(user), st.Roles)
	above := actor.Owner || actor.Outranks(target)
	mine := user.ID == st.Me.ID

	body := []widget.Component{
		widget.Padded{Bottom: fieldMargin, Child: p.rolesField(c, st, user, actor, above, mine)},
	}
	if rows := p.badgeRows(c, st, user, actor); rows != nil {
		body = append(body, widget.Padded{Bottom: fieldMargin, Child: rows})
	}
	if p.problem != "" {
		body = append(body, widget.SettingNote{Content: p.problem, Error: true})
	}
	if actions := p.actions(c, user, actor, target); actions != nil {
		body = append(body, widget.Padded{Top: actionsTop, Child: actions})
	}
	p.card.Set(p.subject(c, user), body...)
	p.split.Editor = &p.card
}

func (p *membersPage) subject(c *widget.Context, user hclient.Account) widget.Component {
	items := []widget.RowItem{
		widget.Fixed(widget.Padded{Right: subjectAvatarGap, Child: widget.Avatar{ID: user.ID, Name: user.Name(), Size: subjectAvatar, Font: subjectFont}}),
		widget.Fixed(p.nameOf(c, user, subjectFace, false)),
	}
	if user.Role == "owner" || user.Role == "admin" {
		items = append(items, widget.Fixed(widget.RoleIcon{Owner: user.Role == "owner"}))
	}
	return &widget.Row{Gap: subjectGap, Items: items}
}

func (p *membersPage) rolesField(c *widget.Context, st *app.State, user hclient.Account, actor hclient.Actor, above, mine bool) widget.Component {
	rows := p.roleRows(c, st, user, actor, above)
	if note := p.note(c, mine && !actor.Owner, !above); note != nil {
		return widget.Col(noteGap, rows, note)
	}
	return rows
}

func (p *membersPage) note(c *widget.Context, own, outranked bool) widget.Component {
	text := ""
	switch {
	case own:
		text = c.T("server_admin.not_your_own_roles")
	case outranked:
		text = c.T("server_admin.outranks_you")
	}
	if text == "" {
		return nil
	}
	return &widget.Text{Content: text, Style: noteFace, LineHeight: noteSize * 1.5, Tone: widget.ToneMuted, Wrap: true}
}

func (p *membersPage) roleRows(c *widget.Context, st *app.State, user hclient.Account, actor hclient.Actor, above bool) *widget.SwitchRows {
	id := user.ID
	rows := &widget.SwitchRows{Label: c.T("server_admin.member_roles")}
	if actor.Owner && user.Role != "owner" {
		rows.Rows = append(rows.Rows, &widget.SwitchRow{
			Label: c.T("roles.admin"), Hint: c.T("server_admin.super_admin_hint"), Sw: widget.Switch{On: user.Role == "admin"},
			OnChange: func(on bool) {
				role := "member"
				if on {
					role = "admin"
				}
				p.send(func(ctx context.Context) error { return p.d.Session.SetAccountRole(ctx, id, role) })
			},
		})
	}
	for _, role := range st.Roles {
		roleID := role.ID
		held := slices.Contains(user.Roles, roleID)
		rows.Rows = append(rows.Rows, &widget.SwitchRow{
			Lead: widget.Dot{Color: roleColor(c, role)}, Label: role.Name, Sw: widget.Switch{On: held},
			Disabled: !above || !actor.CanAssign(role),
			OnChange: func(on bool) {
				ids := toggled(user.Roles, roleID, on)
				p.send(func(ctx context.Context) error { return p.d.Session.SetAccountRoles(ctx, id, ids) })
			},
		})
	}
	return rows
}

// badgeRows is the badges this person may hand out or the member already holds, nil when there are none.
func (p *membersPage) badgeRows(c *widget.Context, st *app.State, user hclient.Account, actor hclient.Actor) *widget.SwitchRows {
	id := user.ID
	rows := &widget.SwitchRows{Label: c.T("server_admin.member_badges")}
	for _, badge := range st.Badges {
		badgeID := badge.ID
		held := slices.Contains(user.Badges, badgeID)
		if !actor.CanAward(badgeID) && !held {
			continue
		}
		rows.Rows = append(rows.Rows, &widget.SwitchRow{
			Lead: widget.BadgeIcon{Emoji: badge.EmojiText(), Hash: badge.Image()}, Label: badge.Name, Sw: widget.Switch{On: held},
			Disabled: !actor.CanAward(badgeID),
			OnChange: func(on bool) {
				ids := toggled(user.Badges, badgeID, on)
				p.send(func(ctx context.Context) error { return p.d.Session.SetAccountBadges(ctx, id, ids) })
			},
		})
	}
	if len(rows.Rows) == 0 {
		return nil
	}
	return rows
}

// actions is Kick and Ban for somebody the person outranks, nil when they may do neither.
func (p *membersPage) actions(c *widget.Context, user hclient.Account, actor, target hclient.Actor) widget.Component {
	over := actor.Outranks(target)
	kickable, bannable := over && actor.Can("users.kick"), over && actor.Can("users.ban")
	if !kickable && !bannable {
		return nil
	}
	row := &widget.Row{Gap: actionsGap, Items: []widget.RowItem{widget.Grow(widget.Spacer{})}}
	name := user.Name()
	if kickable {
		row.Items = append(row.Items, widget.Fixed(&widget.Button{
			Label: c.T("server_admin.kick"), Variant: widget.Ghost,
			OnClick: func() {
				p.d.ask(c.T("server_admin.kick_title", "name", name), c.T("server_admin.kick_text"), c.T("server_admin.kick"), func() {
					p.send(func(ctx context.Context) error { return p.d.Session.Client().KickAccount(ctx, user.ID) })
				})
			},
		}))
	}
	if bannable {
		row.Items = append(row.Items, widget.Fixed(p.banButton(c, user, name)))
	}
	return row
}

func (p *membersPage) banButton(c *widget.Context, user hclient.Account, name string) *widget.Button {
	label, lifting := c.T("server_admin.ban"), user.Banned
	if lifting {
		label = c.T("server_admin.unban")
	}
	return &widget.Button{
		Label: label, Variant: widget.Ghost, Danger: true,
		OnClick: func() {
			ban := func() {
				p.send(func(ctx context.Context) error { return p.d.Session.BanAccount(ctx, user.ID, !lifting) })
			}
			if lifting {
				ban()
				return
			}
			p.d.ask(c.T("server_admin.ban_title", "name", name), c.T("server_admin.ban_text"), c.T("server_admin.ban"), ban)
		},
	}
}
