package serveradmin

import (
	"image/color"
	"strings"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

// permissionGroups are the permissions a role can grant, in the order the page lists them, grouped.
var permissionGroups = []struct {
	key         string
	permissions []string
}{
	{"channels", []string{"channels.create", "channels.edit", "channels.password", "channels.delete"}},
	{"users", []string{"users.mute", "users.kick", "users.ban"}},
	{"messages", []string{"messages.delete", "messages.pin"}},
	{"posts", []string{"posts.delete", "posts.pin"}},
	{"roles", []string{"roles.hierarchy"}},
	{"badges", []string{"badges.create", "badges.edit"}},
	{"music", []string{"music.control"}},
}

const (
	editorFieldGap = 9.6
	editorCheckGap = 12.8
	editorGroupGap = 11.2
	editorHintGap  = 6
)

func permissionKey(permission string) string { return strings.Replace(permission, ".", "_", 1) }

func (p *rolesPage) buildEditor(c *widget.Context, st *app.State, role *hclient.Role, actor hclient.Actor) widget.Component {
	draft := p.draft
	isNew := p.selected == rolesNew
	editable := p.editable

	p.look.Disabled = !editable
	p.look.Sample = draft.Name
	if p.look.Sample == "" {
		p.look.Sample = c.T("server_admin.role_name")
	}
	p.look.Labels.Solid, p.look.Labels.Gradient, p.look.Labels.Rainbow = c.T("profile.color_solid"), c.T("profile.color_gradient"), c.T("profile.color_rainbow")
	p.look.Labels.Add, p.look.Labels.Speed = c.T("profile.color_add"), c.T("profile.color_speed")

	var nameBox widget.Component = &p.nameField
	if !editable {
		nameBox = readOnlyField{text: draft.Name}
	}

	body := []widget.Component{
		widget.Padded{Bottom: editorFieldGap, Child: widget.DialogField(c.T("server_admin.role_name"), nameBox)},
		widget.Padded{Bottom: editorFieldGap, Child: widget.DialogField(c.T("server_admin.role_color"), &p.look)},
		widget.Padded{Bottom: editorCheckGap, Child: p.adminToggle(c, role, actor)},
	}
	for i, group := range permissionGroups {
		block := p.permissionBlock(c, role, actor, group.key, group.permissions)
		if i == len(permissionGroups)-1 {
			block = widget.Padded{Bottom: editorGroupGap, Child: block}
		}
		body = append(body, block)
	}
	others := make([]hclient.Role, 0, len(st.Roles))
	for _, r := range st.Roles {
		if role == nil || r.ID != role.ID {
			others = append(others, r)
		}
	}
	if len(others) > 0 {
		hint := &widget.Text{Content: c.T("server_admin.role_assign_hint"), Style: paint.TextStyle{Size: 12, Weight: paint.Regular}, LineHeight: 18, Tone: widget.ToneMuted, Wrap: true}
		body = append(body, widget.Padded{Bottom: editorFieldGap, Child: widget.Col(editorHintGap, p.assignBlock(c, role, actor, others), hint)})
	}
	if len(st.Badges) > 0 {
		body = append(body, widget.Padded{Bottom: editorFieldGap, Child: p.awardBlock(c, role, actor, st.Badges)})
	}
	if p.err != "" {
		body = append(body, widget.SettingNote{Content: p.err, Error: true})
	}
	p.create.Label, p.create.Disabled = c.T("server_admin.create"), !editable
	p.remove.Label, p.remove.Disabled = c.T("server_admin.delete_role"), !editable
	action := &p.remove
	if isNew {
		action = &p.create
	}
	body = append(body, widget.Padded{Top: rolesButtonTop, Child: &widget.Row{Gap: 8, Items: []widget.RowItem{widget.Grow(widget.Spacer{}), widget.Fixed(action)}}})
	p.card.Set(nil, body...)
	return &p.card
}

func (p *rolesPage) adminToggle(c *widget.Context, role *hclient.Role, actor hclient.Actor) widget.Component {
	p.adminSwitch.On = p.draft.Admin
	p.adminSwitch.Disabled = !p.editable || (!actor.Admin && (role == nil || !role.Admin))
	return plainToggle{title: c.T("server_admin.role_admin"), hint: c.T("server_admin.role_admin_hint"), sw: &p.adminSwitch}
}

func (p *rolesPage) permissionBlock(c *widget.Context, role *hclient.Role, actor hclient.Actor, group string, permissions []string) widget.Component {
	rows := make([]*widget.SwitchRow, 0, len(permissions))
	for _, permission := range permissions {
		row := p.perms[permission]
		if row == nil {
			row = &widget.SwitchRow{}
			perm := permission
			row.OnChange = func(on bool) {
				p.draft.Permissions = toggle(p.draft.Permissions, perm, on)
				p.touch(rolesQuick)
			}
			p.perms[permission] = row
		}
		was := role != nil && contains(role.Permissions, permission)
		row.Label = c.T("server_admin.perm_" + permissionKey(permission))
		row.Hint = c.T("server_admin.perm_" + permissionKey(permission) + "_hint")
		row.Sw.On = p.draft.Admin || contains(p.draft.Permissions, permission)
		row.Disabled = !p.editable || p.draft.Admin || (!actor.Can(permission) && !was)
		rows = append(rows, row)
	}
	return &widget.SwitchRows{Label: c.T("server_admin.group_" + group), Banded: true, Rows: rows}
}

func (p *rolesPage) assignBlock(c *widget.Context, role *hclient.Role, actor hclient.Actor, others []hclient.Role) widget.Component {
	rows := make([]*widget.SwitchRow, 0, len(others))
	for _, other := range others {
		row := p.assign[other.ID]
		if row == nil {
			row = &widget.SwitchRow{}
			id := other.ID
			row.OnChange = func(on bool) {
				p.draft.Assignable = toggle(p.draft.Assignable, id, on)
				p.touch(rolesQuick)
			}
			p.assign[other.ID] = row
		}
		was := role != nil && contains(role.Assignable, other.ID)
		row.Lead = widget.Dot{Color: colourOf(other.Color)}
		row.Label = other.Name
		row.Sw.On = p.draft.Admin || contains(p.draft.Assignable, other.ID)
		row.Disabled = !p.editable || p.draft.Admin || (!actor.CanAssign(other) && !was)
		rows = append(rows, row)
	}
	return &widget.SwitchRows{Label: c.T("server_admin.role_assign"), Rows: rows}
}

func (p *rolesPage) awardBlock(c *widget.Context, role *hclient.Role, actor hclient.Actor, badges []hclient.Badge) widget.Component {
	rows := make([]*widget.SwitchRow, 0, len(badges))
	for _, badge := range badges {
		row := p.award[badge.ID]
		if row == nil {
			row = &widget.SwitchRow{}
			id := badge.ID
			row.OnChange = func(on bool) {
				p.draft.AssignableBadges = toggle(p.draft.AssignableBadges, id, on)
				p.touch(rolesQuick)
			}
			p.award[badge.ID] = row
		}
		was := role != nil && contains(role.AssignableBadges, badge.ID)
		row.Lead = widget.BadgeIcon{Emoji: badge.EmojiText(), Hash: badge.Image()}
		row.Label = badge.Name
		row.Sw.On = p.draft.Admin || contains(p.draft.AssignableBadges, badge.ID)
		row.Disabled = !p.editable || p.draft.Admin || (!actor.CanAward(badge.ID) && !was)
		rows = append(rows, row)
	}
	return &widget.SwitchRows{Label: c.T("server_admin.role_badges"), Rows: rows}
}

func contains[T comparable](list []T, v T) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// rolesRoot is the page: a title, a note and the search box over a split that takes what is left of the window's height.
type rolesRoot struct {
	p     *rolesPage
	title widget.Component
	hint  widget.Component
}

func (r *rolesRoot) Measure(c *widget.Context, width float32) geom.Size {
	return geom.Size{W: width, H: max(r.p.d.win.PageHeight(c), rolesPageMin)}
}

func (r *rolesRoot) Draw(c *widget.Context, b geom.Rect) {
	p := r.p
	y := b.Y
	for _, part := range []widget.Component{r.title, r.hint} {
		h := part.Measure(c, b.W).H
		part.Draw(c, geom.Rect{X: b.X, Y: y, W: b.W, H: h})
		y += h
	}
	y += rolesHintGap
	h := p.filter.Measure(c, b.W).H
	p.filter.Draw(c, geom.Rect{X: b.X, Y: y, W: b.W, H: h})
	y += h + rolesFilterGap
	p.splitH = b.Bottom() - y
	p.split.Draw(c, geom.Rect{X: b.X, Y: y, W: b.W, H: p.splitH})
	p.poll()
}

// poll takes what the text fields now hold.
func (p *rolesPage) poll() {
	if p.filter.Value != p.filterSeen {
		p.filterSeen = p.filter.Value
		p.d.invalidate()
	}
	if p.draft != nil && p.nameField.Value != p.draft.Name {
		p.draft.Name = p.nameField.Value
		p.look.Sample = p.draft.Name
		p.touch(saveDelay)
		p.d.invalidate()
	}
}

// readOnlyField is a field's look for a value that cannot be changed.
type readOnlyField struct{ text string }

func (readOnlyField) Measure(c *widget.Context, w float32) geom.Size {
	f := widget.TextField{Inset: true}
	return f.Measure(c, w)
}

func (f readOnlyField) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.Fill(r, 6, c.Theme.Bg)
	c.Paint.Stroke(r, 6, c.Hairline(), theme.WithAlpha(c.Theme.Tint, 0.16))
	ink := theme.WithAlpha(c.Theme.Text, 0.45)
	c.Paint.TextIn(r, f.text, r.X+7.2, r.Y+5.6, 21, paint.TextStyle{Size: 14, Weight: paint.Regular}, ink)
}

var _ = color.RGBA{}
