package channels

import (
	"context"
	"strings"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/widget"
)

const (
	formGap = 9.6
	// formLift takes back the room the question keeps above its body: this form has fields right under its title.
	formLift = -14.4
)

// newChannelForm is the question "New channel": a name, what kind, and a password for those who may set one.
type newChannelForm struct {
	name     widget.TextField
	kind     widget.Dropdown
	password widget.TextField
	body     *widget.Column
}

// askNew asks for a new channel, or a new group, or with a group given a channel inside it that takes the group's password and roles.
func (s *Screen) askNew(c *widget.Context, a hclient.Actor, in *hclient.Group) {
	f := &newChannelForm{}
	f.name = widget.TextField{Inset: true, Placeholder: c.T("app.game_night"), MaxLength: 32}
	f.password = widget.TextField{Inset: true, Password: true, Placeholder: c.T("app.open_to_everyone")}
	f.kind = widget.Dropdown{Value: "voice", Options: []widget.Option{
		{Value: "voice", Label: c.T("app.voice_channel")},
		{Value: "text", Label: c.T("app.text_channel")},
	}}
	title := c.T("app.new_channel")
	if in != nil {
		title = c.T("server_admin.new_channel_in", "name", in.Name)
	} else {
		f.kind.Options = append(f.kind.Options,
			widget.Option{Value: "forum", Label: c.T("app.forum_channel")},
			widget.Option{Value: "group", Label: c.T("app.group_a_folder")})
	}
	fields := []widget.Component{widget.DialogField(c.T("app.name"), &f.name), widget.DialogField(c.T("app.kind"), &f.kind)}
	if in == nil && a.Can("channels.password") {
		fields = append(fields, widget.DialogField(c.T("app.password"), &f.password))
	}
	f.body = widget.Col(formGap, fields...)
	f.name.RequestFocus()
	submit := func([]string) { f.submit(c, s, in) }
	f.name.OnEnter = func() { submit(nil) }
	f.password.OnEnter = f.name.OnEnter
	c.OpenModal(&widget.Prompt{
		Title: title, OK: c.T("app.create"), Cancel: c.T("app.cancel"), Body: widget.Padded{Top: formLift, Child: f.body},
		OnSubmit: submit, OnCancel: c.CloseModal,
	})
}

func (f *newChannelForm) submit(c *widget.Context, s *Screen, in *hclient.Group) {
	name := strings.TrimSpace(f.name.Value)
	if name == "" {
		return
	}
	c.CloseModal()
	password, kind := f.password.Value, f.kind.Value
	s.run(func(ctx context.Context) error {
		client := s.Session.Client()
		switch {
		case kind == "group":
			_, err := client.CreateGroup(ctx, hclient.NewGroup{Name: name, Password: password})
			return err
		case in != nil:
			_, err := client.CreateChannel(ctx, hclient.NewChannel{Kind: kind, Name: name, GroupID: &in.ID})
			if err == nil {
				c.Post(func() { delete(s.folded, in.ID) })
			}
			return err
		}
		_, err := client.CreateChannel(ctx, hclient.NewChannel{Kind: kind, Name: name, Password: password})
		return err
	})
}
