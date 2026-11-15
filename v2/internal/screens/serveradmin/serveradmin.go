// Package serveradmin is the Server dialog: a menu of pages down the left (General, Roles, Members, Channels, Badges), those the
// signed-in person may use, and the page beside it. Every page is live: a change is sent as it is made, and the footer says how it went.
package serveradmin

import (
	"context"
	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

// Page names, as Target.Tab spells them.
const (
	TabGeneral  = "general"
	TabRoles    = "roles"
	TabMembers  = "members"
	TabChannels = "channels"
	TabBadges   = "badges"
)

// Target is where the dialog opens. Tab empty is the first page the person may use; Kind and ID name what to select on that page
// ("channel" or "group" on Channels, "role" on Roles, "member" on Members, "badge" on Badges).
type Target struct {
	Tab  string
	Kind string
	ID   int
}

// page is one page of the dialog. A page keeps its own widgets between builds, so what is being typed survives the page being built again.
type page interface {
	name() string
	icon() string
	label(c *widget.Context) string
	// visible is whether the person may use the page at all.
	visible(a hclient.Actor) bool
	// build lays the page out from the dialog's state; the dialog calls it again whenever the state or the language changed.
	build(c *widget.Context) widget.Component
}

// flusher is a page with changes waiting to be sent, which are sent when the dialog closes.
type flusher interface{ flush() }

// focuser is a page that can select something on opening.
type focuser interface{ focus(kind string, id int) }

// Dialog is the Server window, shown over everything as a modal.
type Dialog struct {
	Session *app.Session

	pages   []page
	current int
	shown   []int
	state   *app.State
	body    widget.Component
	dirty   bool
	ctx     *widget.Context
	win     widget.SettingsWindow
	picks   []func()
	saves   []*autosave
	prompt  *widget.Prompt
	note    note
	strings *i18n.Bundle
}

// Open shows the dialog on the page and item in target.
func Open(c *widget.Context, session *app.Session, target Target) {
	c.OpenModal(New(session, target))
}

func New(session *app.Session, target Target) *Dialog {
	d := &Dialog{Session: session, dirty: true}
	d.pages = []page{newGeneral(d), newRoles(d), newMembers(d), newChannels(d), newBadges(d)}
	for i := range d.pages {
		d.picks = append(d.picks, func() { d.show(i) })
	}
	d.win.Done.Variant = widget.Primary
	d.win.Done.OnClick = d.close
	d.refresh()
	d.current = d.first()
	for i, p := range d.pages {
		if p.name() == target.Tab && d.allowed(i) {
			d.current = i
		}
	}
	if f, ok := d.pages[d.current].(focuser); ok && target.Kind != "" {
		f.focus(target.Kind, target.ID)
	}
	return d
}

func (d *Dialog) allowed(i int) bool { return d.pages[i].visible(d.state.Actor) }

func (d *Dialog) first() int {
	for i := range d.pages {
		if d.allowed(i) {
			return i
		}
	}
	return 0
}

// refresh takes the session's current state and reports whether it changed.
func (d *Dialog) refresh() bool {
	st := d.Session.State()
	if st == d.state {
		return false
	}
	d.state, d.dirty = st, true
	return true
}

func (d *Dialog) invalidate() { d.dirty = true }

func (d *Dialog) show(i int) {
	d.flushAll()
	d.current, d.win.Scroll, d.dirty = i, widget.Scroll{}, true
}

// close sends what is still waiting and goes.
func (d *Dialog) close() {
	d.flushAll()
	d.ctx.CloseModal()
}

func (d *Dialog) flushAll() {
	for _, p := range d.pages {
		if f, ok := p.(flusher); ok {
			f.flush()
		}
	}
	for _, s := range d.saves {
		s.flush()
	}
}

func (d *Dialog) Draw(c *widget.Context, bounds geom.Rect) {
	d.ctx = c
	if d.prompt != nil {
		c.Frozen(func() { d.drawWindow(c, bounds) })
		d.prompt.Draw(c, bounds)
		return
	}
	c.Layer(d)
	if c.EscapeFor(d) {
		d.close()
		return
	}
	d.drawWindow(c, bounds)
}

func (d *Dialog) drawWindow(c *widget.Context, bounds geom.Rect) {
	d.refresh()
	if !d.state.Actor.CanAdminister() {
		c.CloseModal()
		return
	}
	if !d.allowed(d.current) {
		d.current, d.win.Scroll, d.dirty = d.first(), widget.Scroll{}, true
	}
	if c.Strings != d.strings {
		d.strings, d.dirty = c.Strings, true
	}
	d.win.Title = c.T("server_form.this_server")
	d.win.Done.Label = c.T("devices_close.done")
	d.win.Note, d.win.NoteError = d.note.text(c)
	d.win.Nav = d.win.Nav[:0]
	for i, p := range d.pages {
		if d.allowed(i) {
			d.win.Nav = append(d.win.Nav, widget.NavItem{Icon: p.icon(), Label: p.label(c), Selected: i == d.current, OnClick: d.picks[i]})
		}
	}
	if d.dirty {
		d.body, d.dirty = d.win.PagePadding(d.pages[d.current].build(c)), false
	}
	d.win.Draw(c, bounds, d.body)
}

// ask puts a question over the dialog and runs yes if it is answered with ok.
func (d *Dialog) ask(title, text, ok string, yes func()) {
	c := d.ctx
	d.prompt = &widget.Prompt{
		Title: title, Text: text, OK: ok, Cancel: c.T("app.cancel"),
		OnSubmit: func([]string) {
			d.prompt = nil
			yes()
		},
		OnCancel: func() { d.prompt = nil },
	}
}

// picture is the stored picture with this hash, fetched in the background the first time it is asked for; nil for no hash.
func (d *Dialog) picture(c *widget.Context, hash string) *paint.Picture {
	if hash == "" {
		return nil
	}
	client := d.Session.Client()
	return c.Paint.Picture("h:"+hash, func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		return client.Download(ctx, hash, pictureLimit)
	})
}
