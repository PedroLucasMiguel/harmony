package serveradmin

import (
	"slices"
	"strconv"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const (
	channelsPageMin = 384
	channelsGap     = 6.4
	pickDelay       = 150 * time.Millisecond
)

// What is selected on the Channels page: an existing channel or group, or one about to be made.
const (
	pickNone     = ""
	pickChannel  = "channel"
	pickGroup    = "group"
	pickNewText  = "new-text"
	pickNewVoice = "new-voice"
	pickNewForum = "new-forum"
	pickNewGroup = "new-group"
)

type selection struct {
	kind string
	id   int
}

func (s selection) fresh() bool { return len(s.kind) > 3 && s.kind[:3] == "new" }

func (s selection) group() bool { return s.kind == pickGroup || s.kind == pickNewGroup }

// subject is the channel or group being edited, as the server last said it.
type subject struct {
	name   string
	locked bool
	group  int
	roles  []int
	users  []int
}

// channelsPage lists every channel and group on the left and edits the one selected on the right; what is changed is sent as it is made.
type channelsPage struct {
	d    *Dialog
	save *autosave

	sel    selection
	synced subject
	roles  []int
	users  []int

	list   widget.AdminList
	split  widget.AdminSplit
	card   widget.EditorCard
	splitH float32

	nameBox  widget.TextField
	password widget.TextField
	groupDD  widget.Dropdown
	passOff  widget.Switch
	userAdd  widget.Dropdown
	create   widget.Button
	remove   widget.Button
	adds     [4]widget.Button

	roleRows    map[int]*widget.SwitchRow
	nameFocused bool
	passFocused bool
	passReady   bool
}

func newChannels(d *Dialog) *channelsPage {
	p := &channelsPage{d: d, roleRows: map[int]*widget.SwitchRow{}}
	p.save = d.newAutosave(p.plan)
	p.nameBox.Inset, p.nameBox.MaxLength = true, nameMax
	p.nameBox.OnEnter = p.save.flush
	p.password.Inset, p.password.Password = true, true
	p.password.OnEnter = p.commitPassword
	p.passOff.OnChange = func(on bool) {
		if on {
			p.save.touch(0)
		}
	}
	p.groupDD.OnChange = func(string) { p.save.touch(0) }
	p.userAdd.OnChange = p.addPerson
	p.create.Variant, p.create.OnClick = widget.Primary, p.createNew
	p.remove.Variant, p.remove.Danger, p.remove.OnClick = widget.Ghost, true, p.confirmRemove
	kinds := [...]string{pickNewText, pickNewVoice, pickNewForum, pickNewGroup}
	for i, kind := range kinds {
		p.adds[i].Variant, p.adds[i].Small = widget.Ghost, true
		p.adds[i].OnClick = func() { p.pick(selection{kind: kind}) }
	}
	return p
}

func (p *channelsPage) name() string { return TabChannels }

func (p *channelsPage) icon() string                   { return "hash" }
func (p *channelsPage) label(c *widget.Context) string { return c.T("server_admin.channels") }

func (p *channelsPage) visible(a hclient.Actor) bool {
	return a.Can("channels.create") || a.Can("channels.edit") || a.Can("channels.password") || a.Can("channels.delete")
}

func (p *channelsPage) focus(kind string, id int) { p.pick(selection{kind: kind, id: id}) }

// pick selects something to edit; what was changed on the one left is sent first.
func (p *channelsPage) pick(sel selection) {
	p.save.flush()
	p.sel = sel
	p.card.Scroll = widget.Scroll{}
	p.load()
	p.d.invalidate()
}

// load fills the editor's boxes from the server's word on the selection.
func (p *channelsPage) load() {
	sub, _ := p.subject()
	p.synced = subject{name: sub.name, locked: sub.locked, group: sub.group, roles: slices.Clone(sub.roles), users: slices.Clone(sub.users)}
	p.roles, p.users = slices.Clone(sub.roles), slices.Clone(sub.users)
	p.nameBox.Value, p.password.Value = sub.name, ""
	p.passOff.On, p.passReady = false, false
	p.groupDD.Value = groupValue(sub.group)
}

func groupValue(id int) string {
	if id == 0 {
		return ""
	}
	return strconv.Itoa(id)
}

// subject is what the server says about the selected channel or group; ok is false for one being made, or one that is gone.
func (p *channelsPage) subject() (subject, bool) {
	st := p.d.state
	switch p.sel.kind {
	case pickChannel:
		for _, ch := range st.Channels {
			if ch.ID == p.sel.id {
				group := 0
				if ch.GroupID != nil {
					group = *ch.GroupID
				}
				return subject{name: ch.Name, locked: ch.Locked, group: group, roles: ch.Roles, users: ch.Users}, true
			}
		}
	case pickGroup:
		for _, g := range st.Groups {
			if g.ID == p.sel.id {
				return subject{name: g.Name, locked: g.Locked, roles: g.Roles, users: g.Users}, true
			}
		}
	}
	return subject{}, false
}

// adopt takes what the server changed since the page last looked, leaving alone what has been changed here and not sent yet.
func (p *channelsPage) adopt() {
	if p.sel.kind == pickNone || p.sel.fresh() {
		return
	}
	sub, ok := p.subject()
	if !ok {
		p.save.cancel()
		p.sel = selection{}
		return
	}
	if sub.name != p.synced.name {
		if p.nameBox.Value == p.synced.name {
			p.nameBox.Value = sub.name
		}
		p.synced.name = sub.name
	}
	if !sameSet(sub.roles, p.synced.roles) {
		if sameSet(p.roles, p.synced.roles) {
			p.roles = slices.Clone(sub.roles)
		}
		p.synced.roles = slices.Clone(sub.roles)
	}
	if !sameSet(sub.users, p.synced.users) {
		if sameSet(p.users, p.synced.users) {
			p.users = slices.Clone(sub.users)
		}
		p.synced.users = slices.Clone(sub.users)
	}
	if sub.group != p.synced.group {
		p.groupDD.Value = groupValue(sub.group)
	}
	p.synced.group, p.synced.locked = sub.group, sub.locked
}

func sameSet(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for _, x := range a {
		if !slices.Contains(b, x) {
			return false
		}
	}
	return true
}

func (p *channelsPage) build(c *widget.Context) widget.Component {
	p.adopt()
	st := p.d.state
	actor := st.Actor
	p.buildList(c)
	p.split.List = &p.list
	p.split.Above = nil
	p.split.Below = nil
	if actor.Can("channels.create") {
		for i, key := range [...]string{"server_admin.new_text", "server_admin.new_voice", "server_admin.new_forum", "server_admin.new_group"} {
			p.adds[i].Label = c.T(key)
		}
		p.split.Below = []widget.Component{&flow{gap: channelsGap, items: []widget.Component{&p.adds[0], &p.adds[1], &p.adds[2], &p.adds[3]}}}
	}
	p.split.Editor = nil
	if p.sel.kind != pickNone {
		p.split.Editor = p.buildEditor(c, actor)
	}
	p.split.Height = func(*widget.Context) float32 { return p.splitH }
	return &channelsRoot{p: p, title: widget.PageTitle(p.label(c)), hint: widget.SettingNote{Content: c.T("server_admin.channels_hint")}}
}

// channelsRoot is the page: a title and a note over a split that takes what is left of the window's height.
type channelsRoot struct {
	p     *channelsPage
	title widget.Component
	hint  widget.Component
}

func (r *channelsRoot) Measure(c *widget.Context, width float32) geom.Size {
	return geom.Size{W: width, H: max(r.p.d.win.PageHeight(c), channelsPageMin)}
}

func (r *channelsRoot) Draw(c *widget.Context, b geom.Rect) {
	p := r.p
	y := b.Y
	for _, part := range [...]widget.Component{r.title, r.hint} {
		h := part.Measure(c, b.W).H
		part.Draw(c, geom.Rect{X: b.X, Y: y, W: b.W, H: h})
		y += h
	}
	p.splitH = b.Bottom() - y
	p.split.Draw(c, geom.Rect{X: b.X, Y: y, W: b.W, H: p.splitH})
}
