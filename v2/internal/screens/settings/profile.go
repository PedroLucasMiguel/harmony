package settings

import (
	"context"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	nameMax      = 32
	nameTimeout  = 10 * time.Second
	nameRowGap   = 8
	nameRowAfter = 10
	accountGap   = 16
	accountRows  = 6
	accountSize  = 14
)

type profile struct {
	d       *Dialog
	notes   notes
	face    *picture
	looks   *look
	sound   *sound
	name    widget.TextField
	save    widget.Button
	reset   widget.Button
	current string
	shown   bool
}

// nameRow keeps the buttons beside the field in step with what is typed in it.
type nameRow struct {
	p *profile
	widget.Row
}

func (n *nameRow) Draw(c *widget.Context, r geom.Rect) {
	n.p.save.Disabled = strings.TrimSpace(n.p.name.Value) == n.p.current
	n.Row.Draw(c, r)
}

func newProfile(d *Dialog) *profile {
	p := &profile{d: d}
	p.face, p.looks, p.sound = newPicture(p), newLook(p), newSound(p)
	p.name.Inset = true
	p.name.MaxLength = nameMax
	p.name.OnEnter = p.submit
	p.save.OnClick = p.submit
	p.reset.Variant = widget.Ghost
	p.reset.OnClick = func() { p.send("") }
	return p
}

func (p *profile) icon() string                   { return "user-circle" }
func (p *profile) label(c *widget.Context) string { return c.T("settings.profile") }

func (p *profile) submit() {
	if name := strings.TrimSpace(p.name.Value); name != p.current {
		p.send(name)
	}
}

func (p *profile) send(name string) {
	c := p.d.ctx
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), nameTimeout)
		defer cancel()
		err := p.d.Session.SetDisplayName(ctx, name)
		c.Post(func() {
			switch {
			case err != nil:
				p.notes.name.set(err.Error(), true)
			case name == "":
				p.notes.name.set(c.T("profile.back_to_username"), false)
				p.name.Value = ""
			default:
				p.notes.name.set(c.T("profile.saved"), false)
				p.name.Value = name
			}
			p.d.invalidate()
		})
	}()
}

func (p *profile) build(c *widget.Context) widget.Component {
	me := p.d.Session.State().Me
	p.current = ""
	if me.CustomName {
		p.current = me.DisplayName
	}
	if !p.shown {
		p.name.Value, p.shown = p.current, true
	}
	p.name.Placeholder = me.Nickname
	p.save.Label = c.T("profile_name_save.save")
	p.reset.Label, p.reset.Disabled = c.T("profile_name_reset.use_my_username"), !me.CustomName
	row := &nameRow{p: p, Row: widget.Row{Gap: nameRowGap, Items: []widget.RowItem{
		widget.Grow(&p.name), widget.Fixed(&p.save), widget.Fixed(&p.reset),
	}}}
	nameCard := []widget.Component{
		widget.Padded{Bottom: nameRowAfter, Child: row},
		widget.SettingNote{Content: c.T("settings.profile.shown_to_everybody_instead")},
	}
	nameCard = append(nameCard, p.notes.name.component()...)
	signOut := &widget.Button{Label: c.T("app.sign_out"), Variant: widget.Ghost, Small: true, OnClick: func() {
		c.CloseModal()
		p.d.SignOut()
	}}
	view := p.view(c, me)
	page := widget.Col(0, widget.PageTitle(c.T("settings.profile.profile")))
	page.Children = append(page.Children, p.face.cards(c, view)...)
	page.Children = append(page.Children, &widget.SettingCard{Title: c.T("settings.profile.display_name"), Children: nameCard})
	page.Children = append(page.Children, p.looks.cards(c, view)...)
	page.Children = append(page.Children, p.sound.card(c, view),
		&widget.SettingCard{Title: c.T("settings.profile.account"), Children: []widget.Component{
			p.account(c, me.Nickname, roleName(c, me.Role)),
			widget.SettingNote{Content: c.T("settings.profile.your_username_is_what")},
			widget.Start{Child: signOut},
		}})
	return page
}

// meView is what the page shows of the signed-in account, read when the page is built.
type meView struct {
	id         int
	name       string
	avatarHash string
	bannerHash string
	bannerDim  *int
	font       string
	nameColor  *hclient.NameStyle
	soundHash  string
}

func (p *profile) view(c *widget.Context, me hclient.User) *meView {
	v := &meView{id: me.ID, name: me.DisplayName, avatarHash: me.AvatarHash, bannerHash: me.BannerHash, bannerDim: me.BannerDim, font: me.NameFont, nameColor: me.NameColor, soundHash: me.JoinSoundHash}
	if e := c.People.ByID(me.ID); e != nil {
		v.name, v.avatarHash, v.bannerHash, v.bannerDim, v.font, v.nameColor, v.soundHash = e.Name(), e.AvatarHash, e.BannerHash, e.BannerDim, e.NameFont, e.NameColor, e.JoinSoundHash
	}
	return v
}

// account lists what is known about the account, the names lined up in one column.
func (p *profile) account(c *widget.Context, username, role string) widget.Component {
	names := []string{c.T("settings.profile.username"), c.T("settings.profile.role")}
	values := []string{username, role}
	width := float32(0)
	for _, name := range names {
		width = max(width, widget.Label(name, accountSize, paint.Regular, widget.ToneMuted).Measure(c, 0).W)
	}
	rows := widget.Col(accountRows)
	for i, name := range names {
		label := widget.Label(name, accountSize, paint.Regular, widget.ToneMuted)
		rows.Children = append(rows.Children, &widget.Row{Gap: accountGap, Items: []widget.RowItem{
			widget.Fixed(widget.Padded{Right: width - label.Measure(c, 0).W, Child: label}),
			widget.Grow(widget.Label(values[i], accountSize, paint.Semibold, widget.ToneText)),
		}})
	}
	return rows
}

func roleName(c *widget.Context, role string) string {
	if role == "" {
		role = "member"
	}
	name := c.T("roles." + role)
	if name == "" {
		return name
	}
	return strings.ToUpper(name[:1]) + name[1:]
}
