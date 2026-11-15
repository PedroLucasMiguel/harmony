package serveradmin

import (
	"context"
	"slices"
	"strconv"
	"strings"

	"harmony/v2/internal/arrange"
	"harmony/v2/internal/hclient"
)

// plan is what changed in the editor since the server last said, as the calls that send it; nil when nothing did.
func (p *channelsPage) plan() func(context.Context) error {
	sub, ok := p.subject()
	if !ok || p.sel.fresh() {
		return nil
	}
	id, isGroup := p.sel.id, p.sel.kind == pickGroup
	var patch hclient.Patch
	changed := false
	if name := strings.TrimSpace(p.nameBox.Value); name != "" && name != sub.name {
		patch.Name, changed = &name, true
	}
	wanted := 0
	if p.groupDD.Value != "" {
		wanted, _ = strconv.Atoi(p.groupDD.Value)
	}
	joining := !isGroup && wanted != 0 && wanted != sub.group
	leaving := !isGroup && wanted == 0 && sub.group != 0
	following := !isGroup && sub.group != 0 && !leaving
	if !joining && !following {
		switch {
		case p.passOff.On:
			none := ""
			patch.Password, changed = &none, true
		case p.passReady && p.password.Value != "":
			typed := p.password.Value
			patch.Password, changed = &typed, true
		}
		if !sameSet(p.roles, sub.roles) {
			roles := append(make([]int, 0, len(p.roles)), p.roles...)
			patch.Roles, changed = &roles, true
		}
		if !sameSet(p.users, sub.users) {
			users := append(make([]int, 0, len(p.users)), p.users...)
			patch.Users, changed = &users, true
		}
	}
	if !changed && !joining && !leaving {
		return nil
	}
	st := p.d.state
	nodes := arrange.Of(st.Channels, st.Groups)
	client, c := p.d.Session.Client(), p.d.ctx
	sentPassword := patch.Password != nil
	return func(ctx context.Context) error {
		if leaving {
			if err := client.Arrange(ctx, arrange.Placements(arrange.MoveChannel(nodes, id, arrange.Drop{Kind: arrange.End}))); err != nil {
				return err
			}
		}
		if changed {
			var err error
			if isGroup {
				_, err = client.UpdateGroup(ctx, id, patch)
			} else {
				_, err = client.UpdateChannel(ctx, id, patch)
			}
			if err != nil {
				return err
			}
		}
		if joining {
			if err := client.Arrange(ctx, arrange.Placements(arrange.MoveChannel(nodes, id, arrange.Drop{Kind: arrange.IntoGroup, ID: wanted}))); err != nil {
				return err
			}
		}
		c.Post(func() {
			if sentPassword && p.sel.id == id {
				p.password.Value, p.passReady, p.passOff.On = "", false, false
			}
			p.d.invalidate()
		})
		return nil
	}
}

// createNew makes the channel or group in the editor; it waits for a button because everybody is told of it.
func (p *channelsPage) createNew() {
	name := strings.TrimSpace(p.nameBox.Value)
	if name == "" || !p.sel.fresh() {
		return
	}
	actor := p.d.state.Actor
	password := ""
	if actor.Can("channels.password") {
		password = p.password.Value
	}
	roles, users := slices.Clone(p.roles), slices.Clone(p.users)
	kind := p.sel.kind
	client, c := p.d.Session.Client(), p.d.ctx
	p.d.report(noteSaving, "")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		var made selection
		var err error
		if kind == pickNewGroup {
			var g hclient.Group
			g, err = client.CreateGroup(ctx, hclient.NewGroup{Name: name, Password: password, Roles: roles, Users: users})
			made = selection{kind: pickGroup, id: g.ID}
		} else {
			var ch hclient.Channel
			ch, err = client.CreateChannel(ctx, hclient.NewChannel{Kind: strings.TrimPrefix(kind, "new-"), Name: name, Password: password, Roles: roles, Users: users})
			made = selection{kind: pickChannel, id: ch.ID}
		}
		c.Post(func() {
			if err != nil {
				p.d.report(noteFailed, err.Error())
				return
			}
			p.d.report(noteSaved, "")
			if p.sel.kind == kind {
				p.sel = made
				p.load()
			}
			p.d.invalidate()
		})
	}()
}

func (p *channelsPage) confirmRemove() {
	sub, ok := p.subject()
	if !ok {
		return
	}
	c, id, isGroup := p.d.ctx, p.sel.id, p.sel.kind == pickGroup
	title, text := c.T("server_admin.delete_channel_title", "name", sub.name), c.T("server_admin.delete_channel_text")
	if isGroup {
		title, text = c.T("server_admin.delete_group_title", "name", sub.name), c.T("server_admin.delete_group_text")
	}
	p.d.ask(title, text, c.T("server_admin.delete"), func() {
		p.save.cancel()
		client := p.d.Session.Client()
		p.d.report(noteSaving, "")
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
			defer cancel()
			var err error
			if isGroup {
				err = client.DeleteGroup(ctx, id)
			} else {
				err = client.DeleteChannel(ctx, id)
			}
			c.Post(func() {
				if err != nil {
					p.d.report(noteFailed, err.Error())
					return
				}
				p.d.report(noteSaved, "")
				if p.sel.id == id {
					p.sel = selection{}
				}
				p.d.invalidate()
			})
		}()
	})
}
