package serveradmin

import (
	"slices"
	"strconv"
	"strings"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	chanSubjectSize = 16.8
	smallNoteSize   = 12.8
	smallLine       = 17.9
	quietLine       = 22.7
	blockGap        = 9.6
	buttonLift      = 4.8
	checkAfter      = 3.2
	chipGap         = 5.6
	personPadX      = 8
	personGap       = 5.6
	personX         = 10
	checkSize       = 14.08
)

func (p *channelsPage) title(c *widget.Context, sub subject) string {
	switch p.sel.kind {
	case pickChannel:
		return sub.name
	case pickGroup:
		return c.T("server_admin.group_label", "name", sub.name)
	}
	return c.T("server_admin." + strings.ReplaceAll(p.sel.kind, "-", "_") + "_title")
}

func (p *channelsPage) buildEditor(c *widget.Context, actor hclient.Actor) widget.Component {
	st := p.d.state
	sub, _ := p.subject()
	fresh, isGroup := p.sel.fresh(), p.sel.group()
	canEdit, canPassword := actor.Can("channels.edit"), actor.Can("channels.password")

	var parent *hclient.Group
	if p.sel.kind == pickChannel && sub.group != 0 {
		for i := range st.Groups {
			if st.Groups[i].ID == sub.group {
				parent = &st.Groups[i]
			}
		}
	}

	body := []widget.Component{widget.DialogField(c.T("server_admin.chan_name"), p.typing(&p.nameBox, !fresh && !canEdit, &p.nameFocused, func() { p.save.touch(nameDelay) }, p.save.flush))}

	if p.sel.kind == pickChannel {
		p.groupDD.Options = append(p.groupDD.Options[:0], widget.Option{Value: "", Label: c.T("server_admin.no_group")})
		for _, g := range st.Groups {
			p.groupDD.Options = append(p.groupDD.Options, widget.Option{Value: strconv.Itoa(g.ID), Label: g.Name})
		}
		p.groupDD.Disabled = !canEdit
		body = append(body, widget.DialogField(c.T("server_admin.chan_group"), &p.groupDD))
	}
	switch {
	case parent != nil:
		body = append(body, quiet(c.T("server_admin.follows_group", "name", parent.Name)))
	case p.sel.kind == pickGroup:
		body = append(body, quiet(c.T("server_admin.group_applies")))
	}

	if parent == nil {
		if fresh || canPassword {
			field := []widget.Component{widget.DialogField(c.T("server_form.password"), p.typing(&p.password, !canPassword, &p.passFocused, nil, p.commitPassword))}
			if !fresh {
				note := c.T("server_admin.no_password")
				if sub.locked {
					note = c.T("server_admin.has_password")
				}
				field = append(field, widget.Padded{Top: 3.2, Child: smallNote(note)})
			}
			body = append(body, widget.Col(0, field...))
			if !fresh && sub.locked {
				p.passOff.Disabled = !canPassword
				body = append(body, widget.Padded{Bottom: checkAfter, Child: &checkLine{label: c.T("server_admin.chan_no_password"), sw: &p.passOff}})
			}
		}
		body = append(body, p.roleBlock(c, canEdit), p.peopleBlock(c, canEdit))
	}

	p.create.Label = c.T("server_admin.create")
	p.create.Disabled = fresh && !actor.Can("channels.create")
	p.remove.Label = c.T("server_admin.delete")
	p.remove.Disabled = !actor.Can("channels.delete")
	for i := range body {
		body[i] = widget.Padded{Bottom: blockGap, Child: body[i]}
	}
	if fresh {
		body = append(body, widget.Padded{Top: buttonLift - blockGap, Child: widget.Start{Child: &p.create}})
	} else {
		body = append(body, widget.Padded{Top: buttonLift - blockGap, Child: &endAligned{child: &p.remove}})
	}
	p.card.Set(widget.Label(p.title(c, sub), chanSubjectSize, paint.Semibold, widget.ToneText), body...)
	_ = isGroup
	return &p.card
}

func quiet(content string) widget.Component {
	return &widget.Text{Content: content, Style: paint.TextStyle{Size: checkSize, Weight: paint.Regular}, LineHeight: quietLine, Tone: widget.ToneMuted, Wrap: true}
}

func smallNote(content string) widget.Component {
	return &widget.Text{Content: content, Style: paint.TextStyle{Size: smallNoteSize, Weight: paint.Regular}, LineHeight: smallLine, Tone: widget.ToneMuted, Wrap: true}
}

// typing is a text field that says when it was typed in, and when the keyboard has left it.
func (p *channelsPage) typing(f *widget.TextField, disabled bool, focused *bool, typed, left func()) widget.Component {
	return typingField{f: f, disabled: disabled, focused: focused, typed: typed, left: left}
}

type typingField struct {
	f        *widget.TextField
	disabled bool
	focused  *bool
	typed    func()
	left     func()
}

func (t typingField) Measure(c *widget.Context, w float32) geom.Size { return t.f.Measure(c, w) }

func (t typingField) Draw(c *widget.Context, r geom.Rect) {
	before := t.f.Value
	if t.disabled {
		c.Frozen(func() { t.f.Draw(c, r) })
		return
	}
	t.f.Draw(c, r)
	if t.typed != nil && t.f.Value != before {
		t.typed()
	}
	now := t.f.Focused(c)
	if *t.focused && !now && t.left != nil {
		t.left()
	}
	*t.focused = now
}

// commitPassword sends a password that has been typed, as the box is let go of: half of one would lock people out.
func (p *channelsPage) commitPassword() {
	if p.password.Value != "" {
		p.passReady = true
		p.save.touch(0)
	}
}

// roleBlock is the roles that can see the channel, a switch for each.
func (p *channelsPage) roleBlock(c *widget.Context, canEdit bool) widget.Component {
	rows := make([]*widget.SwitchRow, 0, len(p.d.state.Roles))
	for _, role := range p.d.state.Roles {
		id := role.ID
		row := p.roleRows[id]
		if row == nil {
			row = &widget.SwitchRow{}
			row.OnChange = func(on bool) {
				p.roles = slices.DeleteFunc(p.roles, func(r int) bool { return r == id })
				if on {
					p.roles = append(p.roles, id)
				}
				p.save.touch(pickDelay)
			}
			p.roleRows[id] = row
		}
		row.Lead = widget.Dot{Color: colourOf(role.Color)}
		row.Label = role.Name
		row.Sw.On = slices.Contains(p.roles, id)
		row.Disabled = !canEdit
		rows = append(rows, row)
	}
	return widget.Col(0,
		&widget.SwitchRows{Label: c.T("server_admin.chan_roles"), Rows: rows},
		widget.Padded{Top: 3.2, Child: smallNote(c.T("server_admin.chan_roles_hint"))},
	)
}

// peopleBlock is the people let in by name, as chips that can be taken off, and a list to add another.
func (p *channelsPage) peopleBlock(c *widget.Context, canEdit bool) widget.Component {
	st := p.d.state
	chips := &flow{gap: chipGap}
	for _, id := range p.users {
		name := strconv.Itoa(id)
		for _, a := range st.Members {
			if a.ID == id {
				name = a.Name()
			}
		}
		chips.items = append(chips.items, &personChip{name: name, disabled: !canEdit, label: c.T("server_admin.chan_users_remove"), remove: func() { p.removePerson(id) }})
	}
	p.userAdd.Options = append(p.userAdd.Options[:0], widget.Option{Value: "", Label: c.T("server_admin.chan_users_add")})
	people := make([]hclient.Account, 0, len(st.Members))
	for _, a := range st.Members {
		if !slices.Contains(p.users, a.ID) {
			people = append(people, a)
		}
	}
	slices.SortFunc(people, func(a, b hclient.Account) int {
		return strings.Compare(strings.ToLower(a.Name()), strings.ToLower(b.Name()))
	})
	for _, a := range people {
		p.userAdd.Options = append(p.userAdd.Options, widget.Option{Value: strconv.Itoa(a.ID), Label: a.Name()})
	}
	p.userAdd.Value, p.userAdd.Disabled = "", !canEdit
	parts := []widget.Component{}
	if len(chips.items) > 0 {
		parts = append(parts, widget.Padded{Bottom: 6.4, Child: chips})
	}
	parts = append(parts, &p.userAdd)
	return widget.DialogField(c.T("server_admin.chan_users"), widget.Col(0, parts...))
}

func (p *channelsPage) addPerson(value string) {
	id, err := strconv.Atoi(value)
	if err != nil || slices.Contains(p.users, id) {
		return
	}
	p.users = append(p.users, id)
	p.d.invalidate()
	p.save.touch(pickDelay)
}

func (p *channelsPage) removePerson(id int) {
	p.users = slices.DeleteFunc(p.users, func(u int) bool { return u == id })
	p.d.invalidate()
	p.save.touch(pickDelay)
}

// checkLine is a yes-or-no with its words at the left and the switch at the right.
type checkLine struct {
	label string
	sw    *widget.Switch
}

func (l *checkLine) Measure(c *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: l.sw.Measure(c, w).H}
}

func (l *checkLine) Draw(c *widget.Context, r geom.Rect) {
	size := l.sw.Measure(c, r.W)
	if c.Clicked(r) && !l.sw.Disabled {
		c.Claim()
		l.sw.Toggle()
	}
	line := float32(checkSize * 1.5)
	c.Paint.Text(l.label, r.X, r.Y+(r.H-line)/2, line, paint.TextStyle{Size: checkSize, Weight: paint.Regular}, widget.ToneText.Color(c.Theme))
	l.sw.Draw(c, geom.Rect{X: r.Right() - size.W, Y: r.Y, W: size.W, H: size.H})
}

// endAligned puts a button at the right end of its row.
type endAligned struct{ child widget.Component }

func (e *endAligned) Measure(c *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: e.child.Measure(c, w).H}
}

func (e *endAligned) Draw(c *widget.Context, r geom.Rect) {
	size := e.child.Measure(c, r.W)
	e.child.Draw(c, geom.Rect{X: r.Right() - size.W, Y: r.Y, W: size.W, H: size.H})
}

// personChip is a person's name in a pill with a cross to take them off.
type personChip struct {
	name     string
	label    string
	disabled bool
	remove   func()
}

var personStyle = paint.TextStyle{Size: 11.52, Weight: paint.Regular}

func (p *personChip) Measure(c *widget.Context, _ float32) geom.Size {
	return geom.Size{W: 2*personPadX + c.Paint.TextWidth(p.name, personStyle) + personGap + personX, H: personStyle.Size*1.5 + 2*c.Hairline() + 2}
}

func (p *personChip) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.Stroke(r, r.H/2, c.Hairline(), c.Theme.Border)
	c.Paint.Text(p.name, r.X+personPadX, r.Y+(r.H-personStyle.Size*1.5)/2, personStyle.Size*1.5, personStyle, c.Theme.Muted)
	cross := geom.Rect{X: r.Right() - personPadX - personX, Y: r.Y + (r.H-personX)/2, W: personX, H: personX}
	ink := c.Theme.Muted
	if !p.disabled && c.Hovered(cross) {
		ink = c.Theme.Text
		if c.Clicked(cross) {
			c.Claim()
			p.remove()
		}
	}
	c.Paint.Icon("x", cross, ink)
}
