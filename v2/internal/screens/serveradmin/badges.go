package serveradmin

import (
	"context"
	"strings"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/screens/imageedit"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	badgeNameMax        = 32
	badgeDescriptionMax = 200
	badgeEmojiMax       = 16
	badgeEmojiWidth     = 80
	badgePreviewPad     = 9.6
	badgePreviewRadius  = 10
	badgeRowGap         = 8
	badgeFieldAfter     = 10
	badgeUndecided      = 0
	badgesMinHeight     = 384
	rowNameSize         = 14
	badgeNew            = -1
)

type badgesPage struct {
	d    *Dialog
	save *autosave

	list   widget.AdminList
	split  widget.AdminSplit
	height float32
	editor widget.EditorCard
	add    widget.Button

	title, about, emoji widget.TextField
	pick, removeImage   widget.Button
	create, remove      widget.Button
	selected            int
	loaded              int
	image               string
	busy                bool
}

func newBadges(d *Dialog) *badgesPage {
	p := &badgesPage{d: d, loaded: badgeUndecided}
	p.save = d.newAutosave(p.plan)
	for _, f := range []*widget.TextField{&p.title, &p.about, &p.emoji} {
		f.Inset = true
	}
	p.title.MaxLength, p.about.MaxLength, p.emoji.MaxLength = badgeNameMax, badgeDescriptionMax, badgeEmojiMax
	p.add.Variant, p.add.Small, p.add.OnClick = widget.Ghost, true, func() { p.choose(badgeNew) }
	p.pick.Variant, p.pick.Small, p.pick.OnClick = widget.Ghost, true, p.pickImage
	p.removeImage.Variant, p.removeImage.Small, p.removeImage.OnClick = widget.Ghost, true, p.dropImage
	p.create.OnClick = p.createBadge
	p.remove.Variant, p.remove.Danger, p.remove.OnClick = widget.Ghost, true, p.deleteBadge
	p.list.Empty = ""
	return p
}

func (p *badgesPage) name() string                   { return TabBadges }
func (p *badgesPage) icon() string                   { return "medal" }
func (p *badgesPage) label(c *widget.Context) string { return c.T("server_admin.badges") }

func (p *badgesPage) visible(a hclient.Actor) bool {
	return a.Can("badges.create") || a.Can("badges.edit")
}

func (p *badgesPage) flush() { p.save.flush() }

func (p *badgesPage) focus(kind string, id int) {
	if kind == "badge" {
		p.selected = id
	}
}

// choose selects a badge, sending what was changed on the one being left first.
func (p *badgesPage) choose(id int) {
	p.save.flush()
	p.selected = id
	p.d.invalidate()
}

func (p *badgesPage) current() (hclient.Badge, bool) {
	for _, b := range p.d.state.Badges {
		if b.ID == p.selected {
			return b, true
		}
	}
	return hclient.Badge{}, false
}

// load puts the selected badge's values in the editor when the selection changed.
func (p *badgesPage) load() {
	if p.selected == p.loaded {
		return
	}
	p.loaded = p.selected
	b, _ := p.current()
	p.title.SetValue(b.Name)
	p.about.SetValue(b.Description)
	p.emoji.SetValue(b.EmojiText())
	p.image = b.Image()
}

func (p *badgesPage) input() hclient.BadgeInput {
	return hclient.BadgeInput{Name: strings.TrimSpace(p.title.Value), Description: strings.TrimSpace(p.about.Value), Emoji: strings.TrimSpace(p.emoji.Value), ImageHash: p.image}
}

func (p *badgesPage) plan() func(context.Context) error {
	b, ok := p.current()
	if !ok || !p.d.state.Actor.Can("badges.edit") {
		return nil
	}
	in := p.input()
	if in.Name == "" || (in.Name == b.Name && in.Description == b.Description && in.Emoji == b.EmojiText() && in.ImageHash == b.Image()) {
		return nil
	}
	client := p.d.Session.Client()
	return func(ctx context.Context) error {
		_, err := client.UpdateBadge(ctx, b.ID, in)
		return err
	}
}

func (p *badgesPage) createBadge() {
	if p.busy || !p.d.state.Actor.Can("badges.create") {
		return
	}
	in, c, client := p.input(), p.d.ctx, p.d.Session.Client()
	p.busy = true
	p.d.report(noteSaving, "")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		made, err := client.CreateBadge(ctx, in)
		c.Post(func() {
			p.busy = false
			if err != nil {
				p.d.report(noteFailed, err.Error())
				return
			}
			p.d.report(noteSaved, "")
			p.selected, p.loaded = made.ID, made.ID
			p.image = made.Image()
			p.d.invalidate()
		})
	}()
}

func (p *badgesPage) deleteBadge() {
	b, ok := p.current()
	if !ok {
		return
	}
	p.save.cancel()
	c, client := p.d.ctx, p.d.Session.Client()
	p.d.ask(c.T("server_admin.delete_badge_title", "name", b.Name), c.T("server_admin.delete_badge_text"), c.T("server_admin.delete"), func() {
		p.d.report(noteSaving, "")
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
			defer cancel()
			err := client.DeleteBadge(ctx, b.ID)
			c.Post(func() {
				if err != nil {
					p.d.report(noteFailed, err.Error())
					return
				}
				p.d.report(noteSaved, "")
				p.selected, p.loaded = badgeUndecided, badgeUndecided
				p.d.invalidate()
			})
		}()
	})
}

func (p *badgesPage) pickImage() {
	p.d.editPicture(imageedit.EmojiPicture, p.d.ctx.T("server_admin.badge_choose_image"), func(hash string) {
		p.image = hash
		p.d.invalidate()
		p.touch()
	})
}

func (p *badgesPage) dropImage() {
	p.image = ""
	p.d.invalidate()
	p.touch()
}

// touch sends the change at once; a badge not made yet waits for Create.
func (p *badgesPage) touch() {
	if p.selected > 0 {
		p.save.touch(0)
	}
}

func (p *badgesPage) face(c *widget.Context, hash, emoji string, large bool) widget.BadgeFace {
	return widget.BadgeFace{Picture: p.d.picture(c, hash), Emoji: emoji, Large: large}
}

func (p *badgesPage) build(c *widget.Context) widget.Component {
	p.load()
	actor := p.d.state.Actor
	badges := p.d.state.Badges
	if _, ok := p.current(); !ok && p.selected != badgeNew {
		p.selected = badgeUndecided
		p.load()
	}

	p.list.Rows = p.list.Rows[:0]
	for _, b := range badges {
		id := b.ID
		p.list.Rows = append(p.list.Rows, widget.AdminRow{
			Lead:     p.face(c, b.Image(), b.EmojiText(), false),
			Name:     widget.Label(b.Name, rowNameSize, paint.Regular, widget.ToneText),
			Selected: p.selected == id,
			OnClick:  func() { p.choose(id) },
		})
	}
	p.add.Label = c.T("server_admin.new_badge")
	below := []widget.Component{}
	if actor.Can("badges.create") {
		below = append(below, &p.add)
	}
	p.split.List, p.split.Below, p.split.Editor = &p.list, below, nil
	p.split.Height = func(*widget.Context) float32 { return p.height }
	if p.selected != badgeUndecided {
		p.split.Editor = p.editorCard(c)
	}
	return &badgesView{p: p, title: widget.PageTitle(p.label(c)), hint: widget.SettingNote{Content: c.T("server_admin.badges_hint")}}
}

// badgesView is the page: its title and hint, then the list beside the editor taking the height that is left.
type badgesView struct {
	p           *badgesPage
	title, hint widget.Component
}

func (v *badgesView) head(c *widget.Context, width float32) float32 {
	return v.title.Measure(c, width).H + v.hint.Measure(c, width).H
}

func (v *badgesView) fit(c *widget.Context, width float32) float32 {
	head := v.head(c, width)
	v.p.height = max(v.p.d.win.PageHeight(c), badgesMinHeight) - head
	return head
}

func (v *badgesView) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: v.fit(c, maxWidth) + v.p.split.Measure(c, maxWidth).H}
}

func (v *badgesView) Draw(c *widget.Context, r geom.Rect) {
	head := v.fit(c, r.W)
	titleH := v.title.Measure(c, r.W).H
	v.title.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: titleH})
	v.hint.Draw(c, geom.Rect{X: r.X, Y: r.Y + titleH, W: r.W, H: head - titleH})
	v.p.split.Draw(c, geom.Rect{X: r.X, Y: r.Y + head, W: r.W, H: r.H - head})
}

func (p *badgesPage) editorCard(c *widget.Context) widget.Component {
	actor := p.d.state.Actor
	isNew := p.selected == badgeNew
	editable := actor.Can("badges.edit")
	if isNew {
		editable = actor.Can("badges.create")
	}
	in := p.input()
	preview := badgePreview{face: p.face(c, p.image, in.Emoji, true)}

	p.emoji.Placeholder = "🏆"
	p.pick.Label, p.removeImage.Label = c.T("server_admin.badge_choose_image"), c.T("server_admin.badge_remove_image")
	p.pick.Disabled = !editable
	p.removeImage.Disabled = !editable || p.image == ""
	p.create.Label, p.create.Disabled = c.T("server_admin.create"), !editable || p.busy
	p.remove.Label, p.remove.Disabled = c.T("server_admin.delete"), !actor.Can("badges.edit")

	picture := &widget.Flow{Gap: badgeRowGap, RowGap: badgeRowGap, Items: []widget.Component{
		sized{W: badgeEmojiWidth, Child: p.typing(&p.emoji)}, &p.pick, &p.removeImage,
	}}
	action := &p.remove
	if isNew {
		action = &p.create
	}
	p.editor.Set(nil,
		preview,
		widget.Padded{Bottom: badgeFieldAfter, Child: widget.DialogField(c.T("server_admin.badge_name"), p.typing(&p.title))},
		widget.Padded{Bottom: badgeFieldAfter, Child: widget.DialogField(c.T("server_admin.badge_description"), p.typing(&p.about))},
		widget.Col(0, widget.DialogField(c.T("server_admin.badge_picture"), picture), widget.SettingNote{Content: c.T("server_admin.badge_picture_hint")}),
		widget.Start{Child: action},
	)
	return &p.editor
}

// typing is a text field that sends the badge a moment after the typing stops.
func (p *badgesPage) typing(f *widget.TextField) widget.Component {
	return typed{field: f, touch: func() {
		if p.selected > 0 {
			p.d.invalidate()
			p.save.Touch()
		}
	}}
}

type typed struct {
	field *widget.TextField
	touch func()
}

func (t typed) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return t.field.Measure(c, maxWidth)
}

func (t typed) Draw(c *widget.Context, r geom.Rect) {
	before := t.field.Value
	t.field.Draw(c, r)
	if t.field.Value != before {
		t.touch()
	}
}

// sized gives its child a fixed width.
type sized struct {
	W     float32
	Child widget.Component
}

func (s sized) Measure(c *widget.Context, _ float32) geom.Size {
	return geom.Size{W: s.W, H: s.Child.Measure(c, s.W).H}
}

func (s sized) Draw(c *widget.Context, r geom.Rect) {
	s.Child.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: s.W, H: r.H})
}

// badgePreview is exactly what a card will show: the badge large, in a dashed frame.
type badgePreview struct{ face widget.BadgeFace }

func (b badgePreview) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: b.face.Measure(c, maxWidth).H + 2*badgePreviewPad}
}

func (b badgePreview) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.DashedRoundRect(r, badgePreviewRadius, c.Hairline(), 3, 3, c.Theme.Border)
	size := b.face.Measure(c, r.W)
	b.face.Draw(c, geom.Rect{X: r.X + (r.W-size.W)/2, Y: r.Y + badgePreviewPad, W: size.W, H: size.H})
}
