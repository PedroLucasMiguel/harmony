package channels

import (
	"context"

	"harmony/v2/internal/arrange"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/screens/serveradmin"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

// channelAdmin is what the channel list holds for somebody who manages channels: the menu on a row, the + button, and moving rows.
type channelAdmin struct {
	menu widget.ContextMenu
	add  widget.Button
	drag channelDrag
}

func canManage(a hclient.Actor) bool {
	return a.Can("channels.edit") || a.Can("channels.password") || a.Can("channels.delete")
}

func (s *Screen) showMenu(c *widget.Context, head string, items []widget.MenuItem) {
	if len(items) == 0 {
		return
	}
	menu := &s.admin.menu
	menu.Head, menu.Items, menu.NameOnly = head, items, true
	menu.OpenAt(c.In.MouseX, c.In.MouseY)
}

// nudgeItems offers one place up and one place down, only the ones that would move.
func (s *Screen) nudgeItems(c *widget.Context, group bool, id int) []widget.MenuItem {
	var items []widget.MenuItem
	st := s.Session.State()
	nodes := arrange.Of(st.Channels, st.Groups)
	steps := [...]struct {
		key, icon string
		step      int
	}{{"app.move_up", "arrow-up", -1}, {"app.move_down", "arrow-down", 1}}
	for _, move := range steps {
		if arrange.Nudge(nodes, group, id, move.step) == nil {
			continue
		}
		items = append(items, widget.MenuItem{Icon: move.icon, Label: c.T(move.key), OnPick: func() { s.send(arrange.Nudge(nodes, group, id, move.step)) }})
	}
	return items
}

// channelMenu is the menu of a right-click on a channel's row.
func (s *Screen) channelMenu(c *widget.Context, a hclient.Actor, id int, kind, name string) {
	if !canManage(a) {
		return
	}
	var items []widget.MenuItem
	if a.Can("channels.edit") {
		items = s.nudgeItems(c, false, id)
	}
	items = append(items, widget.MenuItem{Icon: "pencil-simple", Label: c.T("server_admin.edit_channel"), OnPick: func() {
		s.OnServerDialog(serveradmin.Target{Tab: serveradmin.TabChannels, Kind: "channel", ID: id})
	}})
	if a.Can("channels.delete") {
		items = append(items, widget.MenuItem{Icon: "trash", Label: c.T("app.delete_this_channel"), Danger: true, OnPick: func() {
			s.confirmChannelDelete(c, c.T("app.delete", "name", name), c.T("app.everything_written_in_it_goes"), c.T("app.delete_2"), func(ctx context.Context) error {
				return s.Session.Client().DeleteChannel(ctx, id)
			})
		}})
	}
	head := name
	if kind == "text" {
		head = "#" + name
	}
	s.showMenu(c, head, items)
}

// groupMenu is the menu of a right-click on a group's heading.
func (s *Screen) groupMenu(c *widget.Context, a hclient.Actor, id int, name string) {
	if !canManage(a) {
		return
	}
	var items []widget.MenuItem
	if a.Can("channels.edit") {
		items = s.nudgeItems(c, true, id)
	}
	if a.Can("channels.create") {
		items = append(items, widget.MenuItem{Icon: "plus", Label: c.T("server_admin.new_channel_here"), OnPick: func() { s.askNew(c, a, &hclient.Group{ID: id, Name: name}) }})
	}
	items = append(items, widget.MenuItem{Icon: "pencil-simple", Label: c.T("server_admin.edit_group"), OnPick: func() {
		s.OnServerDialog(serveradmin.Target{Tab: serveradmin.TabChannels, Kind: "group", ID: id})
	}})
	if a.Can("channels.delete") {
		items = append(items, widget.MenuItem{Icon: "trash", Label: c.T("app.delete_this_group"), Danger: true, OnPick: func() {
			s.confirmChannelDelete(c, c.T("app.delete_the_group", "name", name), c.T("app.the_channels_in_it_stay_2"), c.T("app.delete_the_group_2"), func(ctx context.Context) error {
				return s.Session.Client().DeleteGroup(ctx, id)
			})
		}})
	}
	s.showMenu(c, name, items)
}

func (s *Screen) confirmChannelDelete(c *widget.Context, title, text, ok string, do func(context.Context) error) {
	c.OpenModal(&widget.Prompt{
		Title: title, Text: text, OK: ok, Cancel: c.T("app.cancel"),
		OnSubmit: func([]string) {
			c.CloseModal()
			s.run(do)
		},
		OnCancel: c.CloseModal,
	})
}

// run makes a call to the server off the interface's thread and shows its failure, if any, in the list.
func (s *Screen) run(do func(context.Context) error) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), mvArrangeTimeout)
		defer cancel()
		s.fail(do(ctx))
	}()
}

// press starts moving a row when the person may arrange the list, and otherwise acts on it at once; a press that does not move is a click either way.
func (s *Screen) press(c *widget.Context, a *hclient.Actor, group bool, id int, kind string, from int, name, icon string) {
	if a.Can("channels.edit") {
		s.admin.drag.begin(c, group, id, kind, from, name, icon)
		return
	}
	if group {
		s.toggleGroup(id)
	} else {
		s.pick(id, kind)
	}
}

func (s *Screen) drawAddChannel(c *widget.Context, a hclient.Actor, head geom.Rect) {
	if !a.Can("channels.create") {
		return
	}
	add := &s.admin.add
	if add.OnClick == nil {
		add.Icon, add.Variant, add.Small = "plus", widget.Ghost, true
		add.OnClick = func() { s.askNew(c, s.Session.State().Actor, nil) }
	}
	size := add.Measure(c, 0)
	add.Draw(c, geom.Rect{X: head.Right() - size.W, Y: head.Y + (head.H-size.H)/2, W: size.W, H: size.H})
}
