package serveradmin

import (
	"sort"
	"strconv"

	"harmony/v2/internal/arrange"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	nestedIndent = 27.2
	lockSize     = 16
	listIconSize = 17.6
)

func kindIcon(kind string) string {
	switch kind {
	case "voice":
		return "speaker-high"
	case "forum":
		return "chats-teardrop"
	}
	return "hash"
}

// buildList lists the channels and groups in the order the sidebar draws them, a group's channels set in under it.
func (p *channelsPage) buildList(c *widget.Context) {
	st := p.d.state
	byID := make(map[int]hclient.Channel, len(st.Channels))
	for _, ch := range st.Channels {
		byID[ch.ID] = ch
	}
	groups := make(map[int]hclient.Group, len(st.Groups))
	for _, g := range st.Groups {
		groups[g.ID] = g
	}
	rows := p.list.Rows[:0]
	row := func(lead widget.Component, text string, bold bool, locked bool, roles, users []int, selected bool, indent float32, click func()) widget.AdminRow {
		weight := paint.Regular
		if bold {
			weight = paint.Semibold
		}
		r := widget.AdminRow{
			Lead:     lead,
			Name:     &widget.Text{Content: text, Style: paint.TextStyle{Size: listNameSize, Weight: weight}, Tone: widget.ToneText},
			Selected: selected,
			Indent:   indent,
			OnClick:  click,
		}
		if locked {
			r.Trail = append(r.Trail, widget.Icon{Name: "lock-simple", Size: lockSize, Tone: widget.ToneMuted})
		}
		if chips := p.restriction(c, roles, users); len(chips.Chips) > 0 {
			r.Trail = append(r.Trail, chips)
		}
		return r
	}
	channel := func(ch hclient.Channel, indent float32) widget.AdminRow {
		id := ch.ID
		lead := widget.Icon{Name: kindIcon(ch.Kind), Size: listIconSize, Tone: widget.ToneMuted}
		return row(lead, ch.Name, false, ch.Locked, ch.Roles, ch.Users, p.sel == selection{pickChannel, id}, indent, func() { p.pick(selection{kind: pickChannel, id: id}) })
	}
	for _, n := range arrange.Of(st.Channels, st.Groups) {
		if !n.Group {
			rows = append(rows, channel(byID[n.ID], 0))
			continue
		}
		g, id := groups[n.ID], n.ID
		rows = append(rows, row(nil, g.Name, true, g.Locked, g.Roles, g.Users, p.sel == selection{pickGroup, id}, 0, func() { p.pick(selection{kind: pickGroup, id: id}) }))
		for _, kid := range n.Kids {
			rows = append(rows, channel(byID[kid], nestedIndent))
		}
	}
	p.list.Rows = rows
}

const listNameSize = 14.08

// restriction is the roles, and the people by name, that a channel or group is kept to, as chips.
func (p *channelsPage) restriction(c *widget.Context, roles, users []int) widget.RoleChips {
	chips := widget.RoleChips{}
	if len(roles) == 0 && len(users) == 0 {
		return chips
	}
	held := make([]hclient.Role, 0, len(roles))
	for _, r := range p.d.state.Roles {
		for _, id := range roles {
			if r.ID == id {
				held = append(held, r)
			}
		}
	}
	sort.SliceStable(held, func(i, j int) bool { return held[i].Position < held[j].Position })
	for _, r := range held {
		chips.Chips = append(chips.Chips, widget.RoleChip{Name: r.Name, Color: colourOf(r.Color)})
	}
	if len(users) > 0 {
		chips.Chips = append(chips.Chips, widget.RoleChip{Name: c.Strings.Plural("server_admin.chan_people_count", len(users), "count", strconv.Itoa(len(users)))})
	}
	return chips
}

// flow lays components out left to right and wraps them onto the next line when the row is full.
type flow struct {
	gap   float32
	items []widget.Component
}

func (f *flow) lines(c *widget.Context, width float32, place func(item widget.Component, x, y float32, size geom.Size)) float32 {
	x, y, line := float32(0), float32(0), float32(0)
	for _, item := range f.items {
		size := item.Measure(c, width)
		if x > 0 && x+size.W > width {
			x, y, line = 0, y+line+f.gap, 0
		}
		if place != nil {
			place(item, x, y, size)
		}
		x += size.W + f.gap
		line = max(line, size.H)
	}
	return y + line
}

func (f *flow) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: f.lines(c, maxWidth, nil)}
}

func (f *flow) Draw(c *widget.Context, r geom.Rect) {
	f.lines(c, r.W, func(item widget.Component, x, y float32, size geom.Size) {
		item.Draw(c, geom.Rect{X: r.X + x, Y: r.Y + y, W: size.W, H: size.H})
	})
}
