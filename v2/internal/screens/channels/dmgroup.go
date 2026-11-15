package channels

import (
	"context"
	"slices"
	"strconv"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/dm"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	dmMaxGroup      = 16
	dmGroupNameMax  = 40
	pickerMaxH      = 288
	pickerGap       = 9.6
	pickerFieldGap  = 6.4
	pickerRowPadY   = 6.4
	pickerRowPadX   = 9.6
	pickerRowGap    = 9.6
	pickerAvatar    = 25.6
	pickerAvatarTxt = 9.6
	pickerNameSize  = 14
	pickerBox       = 13
	pickerNoteSize  = 12
	pickerCount     = 12.8
	pickerCountTop  = 3.2
	pickerRadius    = 8
	pickerBadgeSize = 11.2
	pickerBadgePadX = 7.2
	pickerEmptyPad  = 11.2
)

var (
	pickerNameStyle  = paint.TextStyle{Size: pickerNameSize, Weight: paint.Regular}
	pickerNoteStyle  = paint.TextStyle{Size: pickerNoteSize, Weight: paint.Regular}
	pickerCountStyle = paint.TextStyle{Size: pickerCount, Weight: paint.Regular}
	pickerBadgeStyle = paint.TextStyle{Size: pickerBadgeSize, Weight: paint.Semibold}
)

// dmPicker is the body of the dialog that chooses people for a group: a name, a filter, a tick for each, and what is wrong.
type dmPicker struct {
	s      *Screen
	people []hclient.Account
	picked map[int]bool
	room   int
	named  bool
	name   widget.TextField
	filter widget.TextField
	err    string
	scroll widget.Scroll
	submit *widget.Button
}

func (p *dmPicker) visible() []hclient.Account {
	needle := strings.ToLower(strings.TrimSpace(p.filter.Value))
	var out []hclient.Account
	for _, a := range p.people {
		if needle == "" || strings.Contains(strings.ToLower(a.Name()), needle) {
			out = append(out, a)
		}
	}
	return out
}

func (p *dmPicker) listHeight(rows int) float32 {
	if rows == 0 {
		return 2*pickerEmptyPad + pickerNameSize*1.5
	}
	return min(pickerMaxH, float32(rows)*(2*pickerRowPadY+pickerAvatar)+float32(rows-1))
}

func (p *dmPicker) Measure(c *widget.Context, w float32) geom.Size {
	field := p.filter.Measure(c, w).H
	h := field + pickerFieldGap*2
	if p.named {
		h += field + pickerFieldGap*2
	}
	h += pickerGap + p.listHeight(len(p.visible())) + 2*c.Hairline() + pickerGap + pickerCountTop + pickerCount*1.5
	if p.err != "" {
		h += dmNoteTextLine
	}
	return geom.Size{W: w, H: h}
}

func (p *dmPicker) Draw(c *widget.Context, r geom.Rect) {
	d := p.s.dm.feed
	y := r.Y
	field := p.filter.Measure(c, r.W).H
	if p.named {
		p.name.Placeholder = c.T("dm.group.name_placeholder")
		p.name.MaxLength = dmGroupNameMax
		p.name.Draw(c, geom.Rect{X: r.X, Y: y + pickerFieldGap, W: r.W, H: field})
		y += field + 2*pickerFieldGap
	}
	p.filter.Placeholder = c.T("dm.group.search")
	p.filter.Draw(c, geom.Rect{X: r.X, Y: y + pickerFieldGap, W: r.W, H: field})
	y += field + 2*pickerFieldGap + pickerGap

	list := p.visible()
	edge := c.Hairline()
	box := geom.Rect{X: r.X, Y: y, W: r.W, H: p.listHeight(len(list)) + 2*edge}
	c.Paint.Stroke(box, pickerRadius, edge, c.Theme.Border)
	if len(list) == 0 {
		c.Paint.Text(c.T("dm.group.none_left"), box.X+pickerEmptyPad, box.Y+pickerEmptyPad, pickerNameSize*1.5, pickerNameStyle, c.Theme.Muted)
	} else {
		rows := make([]widget.Component, len(list))
		for i, a := range list {
			rows[i] = pickerRow{p: p, who: a, keyed: p.s.Session.DM().CanWriteTo(a.ID), first: i == 0}
		}
		p.scroll.Bar = true
		p.scroll.Child = widget.Col(0, rows...)
		inner := box.InsetAll(edge)
		c.Paint.PushClip(inner)
		p.scroll.Draw(c, inner)
		c.Paint.PopClip()
	}
	y = box.Bottom() + pickerGap + pickerCountTop
	counter := c.T("dm.group.selected", "count", strconv.Itoa(len(p.picked)), "max", strconv.Itoa(p.room))
	c.Paint.Text(counter, r.X, y, pickerCount*1.5, pickerCountStyle, c.Theme.Muted)
	if p.err != "" {
		c.Paint.Text(p.err, r.X, y+pickerCount*1.5+2, dmNoteTextLine, dmNoteStyle, c.Theme.Danger)
	}
	_ = d
	p.submit.Disabled = len(p.picked) == 0 || p.named && strings.TrimSpace(p.name.Value) == ""
}

type pickerRow struct {
	p     *dmPicker
	who   hclient.Account
	keyed bool
	first bool
}

func (r pickerRow) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: 2*pickerRowPadY + pickerAvatar + boolEdge(!r.first)}
}

func boolEdge(on bool) float32 {
	if on {
		return 1
	}
	return 0
}

func (r pickerRow) Draw(c *widget.Context, b geom.Rect) {
	p := r.p
	if !r.first {
		c.Paint.Fill(geom.Rect{X: b.X, Y: b.Y, W: b.W, H: c.Hairline()}, 0, c.Theme.Border)
		b.Y += 1
		b.H -= 1
	}
	on := p.picked[r.who.ID]
	usable := r.keyed && (on || len(p.picked) < p.room)
	if usable && c.Hovered(b) {
		c.Paint.Fill(b, 0, theme.WithAlpha(c.Theme.Tint, 0.06))
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(b) {
			c.Claim()
			if on {
				delete(p.picked, r.who.ID)
			} else {
				p.picked[r.who.ID] = true
			}
		}
	}
	box := geom.Rect{X: b.X + pickerRowPadX, Y: b.Y + (b.H-pickerBox)/2, W: pickerBox, H: pickerBox}
	switch {
	case on:
		c.Paint.Fill(box, 2, c.Theme.Accent)
		c.Paint.Line(box.X+3, box.Y+6.8, box.X+5.6, box.Y+9.4, 1.6, widget.ToneOnAccent.Color(c.Theme))
		c.Paint.Line(box.X+5.4, box.Y+9.4, box.X+10, box.Y+3.8, 1.6, widget.ToneOnAccent.Color(c.Theme))
	default:
		ink := c.Theme.Muted
		if !usable {
			ink = theme.WithAlpha(ink, 0.4)
		}
		c.Paint.Stroke(box, 2, c.Hairline(), ink)
	}
	x := box.Right() + pickerRowGap
	widget.Avatar{Name: r.who.Name(), Size: pickerAvatar, Font: pickerAvatarTxt}.Draw(c, geom.Rect{X: x, Y: b.Y + (b.H-pickerAvatar)/2, W: pickerAvatar, H: pickerAvatar})
	x += pickerAvatar + pickerRowGap
	right := b.Right() - pickerRowPadX
	if !r.keyed {
		note := c.T("dm.group.no_key")
		w := c.Paint.TextWidth(note, pickerNoteStyle)
		c.Paint.Text(note, right-w, b.Y+(b.H-pickerNoteSize*1.5)/2, pickerNoteSize*1.5, pickerNoteStyle, c.Theme.Muted)
		right -= w + pickerRowGap
	}
	ink := c.Theme.Text
	if !usable {
		ink = theme.WithAlpha(ink, 0.5)
	}
	c.Paint.TextIn(geom.Rect{X: x, Y: b.Y, W: max(0, right-x), H: b.H}, r.who.Name(), x, b.Y+(b.H-pickerNameSize*1.5)/2, pickerNameSize*1.5, pickerNameStyle, ink)
}

// pickPeople asks for people from this server's, to put in a group, and what to do with the choice.
func (s *Screen) pickPeople(c *widget.Context, title, confirm string, exclude []int, room int, named bool, run func(ctx context.Context, ids []int, name string) error) {
	me := s.Session.State().Me.ID
	var people []hclient.Account
	for _, a := range s.Session.State().Members {
		if a.ID != me && !slices.Contains(exclude, a.ID) {
			people = append(people, a)
		}
	}
	slices.SortFunc(people, func(a, b hclient.Account) int {
		return strings.Compare(strings.ToLower(a.Name()), strings.ToLower(b.Name()))
	})
	body := &dmPicker{s: s, people: people, picked: map[int]bool{}, room: room, named: named}
	if named {
		body.name.RequestFocus()
	} else {
		body.filter.RequestFocus()
	}
	prompt := &widget.Prompt{Title: title, Width: dmDialogWidth, OnCancel: c.CloseModal, Body: body}
	submit := &widget.Button{Label: confirm, Variant: widget.Primary, Disabled: true}
	submit.OnClick = func() {
		if prompt.Busy {
			return
		}
		prompt.Busy, body.err = true, ""
		ids := make([]int, 0, len(body.picked))
		for id := range body.picked {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		name := strings.TrimSpace(body.name.Value)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
			defer cancel()
			err := run(ctx, ids, name)
			c.Post(func() {
				prompt.Busy = false
				if err != nil {
					body.err = s.dm.feed.words(err).Error()
					return
				}
				c.CloseModal()
			})
		}()
	}
	body.submit = submit
	prompt.Buttons = []*widget.Button{{Label: c.T("app.cancel"), Variant: widget.Ghost, OnClick: c.CloseModal}, submit}
	c.OpenModal(prompt)
}

func (s *Screen) newGroup(c *widget.Context) {
	session := s.Session.DM()
	s.pickPeople(c, c.T("dm.group.new_title"), c.T("dm.group.create"), nil, dmMaxGroup-1, true,
		func(ctx context.Context, ids []int, name string) error {
			id, err := session.CreateGroup(ctx, name, ids)
			if err == nil {
				c.Post(func() { s.openConversation(id) })
			}
			return err
		})
}

func (s *Screen) addPeople(c *widget.Context, id int) {
	session := s.Session.DM()
	conv := session.Conversation(id)
	if conv == nil {
		return
	}
	title := s.conversationName(c, model{state: s.Session.State()}, conv)
	s.pickPeople(c, c.T("dm.group.add_title", "title", title), c.T("dm.group.add"), conv.Members, dmMaxGroup-len(conv.Members), false,
		func(ctx context.Context, ids []int, _ string) error { return session.AddMembers(ctx, id, ids) })
}

func (s *Screen) renameGroup(c *widget.Context, id int) {
	session := s.Session.DM()
	conv := session.Conversation(id)
	if conv == nil {
		return
	}
	name := &widget.PromptField{Label: c.T("dm.group.name"), Required: true}
	name.Input.Value = conv.Title
	c.OpenModal(&widget.Prompt{
		Title: c.T("dm.group.rename_title"), Fields: []*widget.PromptField{name}, OK: c.T("dm.group.rename"), Cancel: c.T("app.cancel"), OnCancel: c.CloseModal,
		OnSubmit: func(values []string) {
			c.CloseModal()
			s.dmDo(func(ctx context.Context) error { return session.Rename(ctx, id, strings.TrimSpace(values[0])) })
		},
	})
}

func (s *Screen) leaveGroup(c *widget.Context, id int, title string) {
	session := s.Session.DM()
	s.confirm(c, c.T("dm.group.leave_title", "title", title), c.T("dm.group.leave_text"), c.T("dm.group.leave"), func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), dmRequestTimeout)
			defer cancel()
			err := session.Leave(ctx, id)
			c.Post(func() {
				s.fail(s.dm.feed.words(err))
				if err == nil && s.dm.current == id {
					s.closeConversation()
				}
			})
		}()
	})
}

// membersBody lists who is in a group, with what the one who runs it can do.
type membersBody struct {
	s      *Screen
	id     int
	scroll widget.Scroll
}

func (b *membersBody) conv() *dm.Conversation { return b.s.Session.DM().Conversation(b.id) }

func (b *membersBody) Measure(c *widget.Context, w float32) geom.Size {
	conv := b.conv()
	if conv == nil {
		return geom.Size{W: w}
	}
	rows := float32(len(conv.Members))
	list := min(pickerMaxH, rows*(2*pickerRowPadY+pickerAvatar)+max(0, rows-1))
	return geom.Size{W: w, H: dmNoteTextLine*1.1 + pickerGap + list + 2*c.Hairline()}
}

func (b *membersBody) Draw(c *widget.Context, r geom.Rect) {
	conv := b.conv()
	if conv == nil {
		c.CloseModal()
		return
	}
	me := b.s.Session.State().Me.ID
	runs := conv.Owner == me
	text := c.Strings.Plural("dm.group.count", len(conv.Members), "count", strconv.Itoa(len(conv.Members)))
	if !runs {
		text = c.T("dm.group.only_owner")
	}
	c.Paint.Text(text, r.X, r.Y, dmNoteTextLine*1.1, dmNoteStyle, c.Theme.Muted)
	box := geom.Rect{X: r.X, Y: r.Y + dmNoteTextLine*1.1 + pickerGap, W: r.W, H: r.H - dmNoteTextLine*1.1 - pickerGap}
	edge := c.Hairline()
	c.Paint.Stroke(box, pickerRadius, edge, c.Theme.Border)
	members := b.s.Session.State().Members
	rows := make([]widget.Component, len(conv.Members))
	for i, id := range conv.Members {
		name := c.T("reactions.someone")
		for _, a := range members {
			if a.ID == id {
				name = a.Name()
			}
		}
		rows[i] = memberDialogRow{b: b, id: id, name: name, you: id == me, owner: id == conv.Owner, runs: runs, first: i == 0}
	}
	b.scroll.Bar = true
	b.scroll.Child = widget.Col(0, rows...)
	inner := box.InsetAll(edge)
	c.Paint.PushClip(inner)
	b.scroll.Draw(c, inner)
	c.Paint.PopClip()
}

type memberDialogRow struct {
	b     *membersBody
	id    int
	name  string
	you   bool
	owner bool
	runs  bool
	first bool
}

func (r memberDialogRow) Measure(_ *widget.Context, w float32) geom.Size {
	return geom.Size{W: w, H: 2*pickerRowPadY + pickerAvatar + boolEdge(!r.first)}
}

func (r memberDialogRow) Draw(c *widget.Context, b geom.Rect) {
	if !r.first {
		c.Paint.Fill(geom.Rect{X: b.X, Y: b.Y, W: b.W, H: c.Hairline()}, 0, c.Theme.Border)
		b.Y += 1
		b.H -= 1
	}
	x := b.X + pickerRowPadX
	widget.Avatar{Name: r.name, Size: pickerAvatar, Font: pickerAvatarTxt}.Draw(c, geom.Rect{X: x, Y: b.Y + (b.H-pickerAvatar)/2, W: pickerAvatar, H: pickerAvatar})
	x += pickerAvatar + pickerRowGap
	right := b.Right() - pickerRowPadX
	switch {
	case r.owner:
		label := c.T("dm.group.owner")
		w := c.Paint.TextWidth(label, pickerBadgeStyle) + 2*pickerBadgePadX
		h := float32(pickerBadgeSize*1.5 + 1.6)
		pill := geom.Rect{X: right - w, Y: b.Y + (b.H-h)/2, W: w, H: h}
		c.Paint.Fill(pill, h/2, theme.WithAlpha(c.Theme.Tint, 0.12))
		c.Paint.Text(label, pill.X+pickerBadgePadX, pill.Y+0.8, pickerBadgeSize*1.5, pickerBadgeStyle, c.Theme.Muted)
		right = pill.X - pickerRowGap
	case r.runs:
		button := &widget.Button{Label: c.T("dm.group.remove"), Variant: widget.Ghost, Small: true, OnClick: func() { r.b.s.confirmRemove(c, r.b.id, r.id, r.name) }}
		size := button.Measure(c, 0)
		button.Draw(c, geom.Rect{X: right - size.W, Y: b.Y + (b.H-size.H)/2, W: size.W, H: size.H})
		right -= size.W + pickerRowGap
	}
	name := r.name
	if r.you {
		name += " (" + c.T("dm.group.you") + ")"
	}
	c.Paint.TextIn(geom.Rect{X: x, Y: b.Y, W: max(0, right-x), H: b.H}, name, x, b.Y+(b.H-pickerNameSize*1.5)/2, pickerNameSize*1.5, pickerNameStyle, c.Theme.Text)
}

func (s *Screen) confirmRemove(c *widget.Context, id, user int, name string) {
	session := s.Session.DM()
	prompt := &widget.Prompt{
		Title: c.T("dm.group.remove_confirm_title", "name", name), Text: c.T("dm.group.remove_confirm_text", "name", name),
		OK: c.T("dm.group.remove"), Cancel: c.T("app.cancel"),
	}
	prompt.OnCancel = func() { s.showMembers(c, id) }
	prompt.OnSubmit = func([]string) {
		s.showMembers(c, id)
		s.dmDo(func(ctx context.Context) error { return session.RemoveMember(ctx, id, user) })
	}
	c.OpenModal(prompt)
}

// showMembers lists who is in a group, and lets the one who runs it add and remove people.
func (s *Screen) showMembers(c *widget.Context, id int) {
	session := s.Session.DM()
	conv := session.Conversation(id)
	if conv == nil {
		return
	}
	title := s.conversationName(c, model{state: s.Session.State()}, conv)
	buttons := []*widget.Button{{Label: c.T("dm.close"), Variant: widget.Ghost, OnClick: c.CloseModal}}
	if conv.Owner == s.Session.State().Me.ID && len(conv.Members) < dmMaxGroup {
		buttons = append(buttons, &widget.Button{Label: c.T("dm.group.add_people"), Variant: widget.Primary, OnClick: func() { s.addPeople(c, id) }})
	}
	c.OpenModal(&widget.Prompt{
		Title: c.T("dm.group.members_title", "title", title), Width: dmDialogWidth, OnCancel: c.CloseModal,
		Body: &membersBody{s: s, id: id}, Buttons: buttons,
	})
}
