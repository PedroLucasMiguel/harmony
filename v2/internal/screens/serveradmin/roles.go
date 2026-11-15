package serveradmin

import (
	"context"
	"image/color"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	rolesPageMin   = 384
	rolesFilterGap = 11.2
	rolesHintGap   = 1.3
	rolesNone      = 0
	rolesNew       = -1
	rolesButtonTop = 4.8
	rolesSpeedW    = 112
	rolesRowFace   = 14
	rolesQuick     = 150 * time.Millisecond
)

type rolesPage struct {
	d *Dialog

	filter      widget.TextField
	filterSeen  string
	list        widget.AdminList
	split       widget.AdminSplit
	card        widget.EditorCard
	nameField   widget.TextField
	look        widget.NameStyleEditor
	adminSwitch widget.Switch
	perms       map[string]*widget.SwitchRow
	assign      map[int]*widget.SwitchRow
	award       map[int]*widget.SwitchRow
	save        *autosave

	create widget.Button
	remove widget.Button
	add    widget.Button

	selected int
	draft    *roleDraft
	editable bool
	err      string
	splitH   float32
}

func newRoles(d *Dialog) *rolesPage {
	p := &rolesPage{d: d, perms: map[string]*widget.SwitchRow{}, assign: map[int]*widget.SwitchRow{}, award: map[int]*widget.SwitchRow{}}
	p.save = d.newAutosave(p.plan)
	p.filter.Inset, p.nameField.Inset = true, true
	p.nameField.MaxLength = 32
	p.look.OnChange = p.lookChanged
	p.look.SpeedWidth = rolesSpeedW
	p.adminSwitch.OnChange = func(on bool) {
		if p.draft != nil {
			p.draft.Admin = on
			p.d.invalidate()
			p.touch(rolesQuick)
		}
	}
	p.add.Variant, p.add.Small = widget.Ghost, true
	p.add.OnClick = func() { p.selectRole(rolesNew) }
	p.create.Variant = widget.Primary
	p.create.OnClick = p.createRole
	p.remove.Variant, p.remove.Danger = widget.Ghost, true
	p.remove.OnClick = p.askDelete
	return p
}

func (p *rolesPage) name() string                   { return TabRoles }
func (p *rolesPage) icon() string                   { return "key" }
func (p *rolesPage) label(c *widget.Context) string { return c.T("server_admin.roles") }

func (p *rolesPage) visible(a hclient.Actor) bool { return a.Can("roles.hierarchy") }

func (p *rolesPage) focus(kind string, id int) {
	if kind == "role" {
		p.selectRole(id)
	}
}

func (p *rolesPage) role(id int) *hclient.Role {
	for i := range p.d.state.Roles {
		if p.d.state.Roles[i].ID == id {
			return &p.d.state.Roles[i]
		}
	}
	return nil
}

// selectRole shows another role, after what was changed on the one being left has gone out.
func (p *rolesPage) selectRole(id int) {
	p.save.flush()
	p.selected, p.draft, p.err = id, nil, ""
	p.d.report(noteNone, "")
	p.d.invalidate()
}

func (p *rolesPage) loadDraft(role *hclient.Role) {
	d := draftOf(role)
	p.draft = &d
	p.nameField.Value = d.Name
	p.look.Set(d.Look)
	p.err = ""
}

func (p *rolesPage) touch(delay time.Duration) {
	if p.draft != nil && p.selected > 0 && p.editable {
		p.save.touch(delay)
	}
}

func (p *rolesPage) lookChanged(delay time.Duration) {
	if p.draft != nil {
		p.draft.Look = p.look.Value
		p.touch(delay)
	}
}

// plan is what the autosave sends: the role on show as the editor holds it, or nothing while there is nothing to send.
func (p *rolesPage) plan() func(context.Context) error {
	if p.draft == nil || p.selected <= 0 || !p.editable {
		return nil
	}
	body := p.draft.body()
	if body == nil {
		return nil
	}
	id, session, c := p.selected, p.d.Session, p.d.ctx
	return func(ctx context.Context) error {
		err := session.UpdateRole(ctx, id, *body)
		c.Post(func() { p.fail(err) })
		return err
	}
}

func (p *rolesPage) fail(err error) {
	p.err = ""
	if err != nil {
		p.err = err.Error()
	}
	p.d.invalidate()
}

func (p *rolesPage) createRole() {
	p.err = ""
	if p.draft == nil || p.selected != rolesNew {
		return
	}
	body := p.draft.bare()
	if body == nil {
		p.err = p.d.ctx.T("server_admin.bad_color")
		p.d.invalidate()
		return
	}
	session, c := p.d.Session, p.d.ctx
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		role, err := session.CreateRole(ctx, *body)
		c.Post(func() {
			if err != nil {
				p.fail(err)
				return
			}
			p.selected, p.draft = role.ID, nil
			p.d.invalidate()
		})
	}()
}

func (p *rolesPage) askDelete() {
	role := p.role(p.selected)
	if role == nil {
		return
	}
	c := p.d.ctx
	id := role.ID
	p.d.ask(c.T("server_admin.delete_role_title", "name", role.Name), c.T("server_admin.delete_role_text"), c.T("server_admin.delete_role"), func() {
		p.save.cancel()
		session := p.d.Session
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
			defer cancel()
			err := session.DeleteRole(ctx, id)
			c.Post(func() {
				if err != nil {
					p.fail(err)
					return
				}
				if p.selected == id {
					p.selected, p.draft = rolesNone, nil
				}
				p.d.invalidate()
			})
		}()
	})
}

func (p *rolesPage) reorder(ids []int) {
	session, c := p.d.Session, p.d.ctx
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		if err := session.ReorderRoles(ctx, ids); err != nil {
			c.Post(func() { p.d.report(noteFailed, err.Error()) })
		}
	}()
}

func (p *rolesPage) build(c *widget.Context) widget.Component {
	st := p.d.state
	actor := st.Actor
	var role *hclient.Role
	if p.selected > 0 {
		if role = p.role(p.selected); role == nil {
			p.save.cancel()
			p.selected, p.draft = rolesNone, nil
		}
	}
	if p.selected != rolesNone && p.draft == nil {
		p.loadDraft(role)
	}
	p.editable = false
	if p.selected == rolesNew {
		p.editable = actor.Can("roles.hierarchy")
	} else if role != nil {
		p.editable = actor.CanManageRole(*role)
	}

	p.buildList(c, st.Roles, actor)
	p.split.List = &p.list
	p.filter.Placeholder = c.T("server_admin.find_role")
	p.add.Label = c.T("server_admin.new_role")
	p.split.Above = nil
	p.split.Below = nil
	if actor.Can("roles.hierarchy") {
		p.split.Below = []widget.Component{&p.add}
	}
	p.split.Editor = nil
	if p.selected != rolesNone {
		p.split.Editor = p.buildEditor(c, st, role, actor)
	}
	p.split.Height = func(*widget.Context) float32 { return p.splitH }
	return &rolesRoot{p: p, title: widget.PageTitle(p.label(c)), hint: widget.SettingNote{Content: c.T("server_admin.roles_hint")}}
}

type arrows struct {
	up, down widget.Button
	zone     geom.Rect
}

func (a *arrows) Measure(c *widget.Context, w float32) geom.Size {
	u, d := a.up.Measure(c, w), a.down.Measure(c, w)
	return geom.Size{W: u.W + d.W + arrowGap, H: max(u.H, d.H)}
}

const arrowGap = 8

func (a *arrows) Draw(c *widget.Context, r geom.Rect) {
	a.zone = r
	u, d := a.up.Measure(c, r.W), a.down.Measure(c, r.W)
	a.up.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: u.W, H: r.H})
	a.down.Draw(c, geom.Rect{X: r.X + u.W + arrowGap, Y: r.Y, W: d.W, H: r.H})
}

func (p *rolesPage) buildList(c *widget.Context, roles []hclient.Role, actor hclient.Actor) {
	needle := strings.ToLower(strings.TrimSpace(p.filter.Value))
	filtered := needle != ""
	rows := p.list.Rows[:0]
	for index, role := range roles {
		if filtered && !strings.Contains(strings.ToLower(role.Name), needle) {
			continue
		}
		pair := &arrows{}
		pair.up = widget.Button{Icon: "arrow-up", Variant: widget.Ghost, Small: true}
		pair.down = widget.Button{Icon: "arrow-down", Variant: widget.Ghost, Small: true}
		for _, move := range [2]struct {
			step   int
			button *widget.Button
		}{{-1, &pair.up}, {1, &pair.down}} {
			to := index + move.step
			ids := make([]int, len(roles))
			for i, r := range roles {
				ids[i] = r.ID
			}
			may := !filtered && to >= 0 && to < len(roles)
			if may {
				ids[index], ids[to] = ids[to], ids[index]
				may = actor.CanReorderTo(roles, ids) && actor.CanManageRole(role) && actor.CanManageRole(roles[to])
			}
			move.button.Disabled = !may
			move.button.OnClick = func() { p.reorder(ids) }
		}
		id := role.ID
		look := people.LookOf(people.RoleLook(role))
		rows = append(rows, widget.AdminRow{
			Lead:     widget.Dot{Color: colourOf(role.Color)},
			Name:     &widget.NameLabel{Text: role.Name, Look: &look, Face: paint.TextStyle{Size: rolesRowFace, Weight: paint.Regular}, Ink: c.Theme.Text},
			Trail:    []widget.Component{pair},
			Selected: id == p.selected,
			OnClick: func() {
				if !pair.zone.Contains(c.In.MouseX, c.In.MouseY) {
					p.selectRole(id)
				}
			},
		})
	}
	p.list.Rows = rows
	p.list.Empty = ""
	if filtered && len(rows) == 0 {
		p.list.Empty = c.T("server_admin.no_roles_match")
	}
}

func colourOf(hex string) color.RGBA {
	c, _ := people.ParseColor(hex)
	return c
}
