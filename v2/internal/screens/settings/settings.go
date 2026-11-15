// Package settings is the settings window: a menu of pages down the left and the page chosen beside it.
package settings

import (
	"image/color"

	"harmony/v2/internal/app"
	"harmony/v2/internal/audio"
	"harmony/v2/internal/desktop"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	backdrop      = 140
	widthMin      = 768
	widthShare    = 0.7
	widthMax      = 1248
	widthCap      = 0.94
	heightMin     = 576
	heightShare   = 0.85
	heightMax     = 960
	heightCap     = 0.92
	cardEdgeAlpha = 0.14
	cardRadius    = 10
	navMin        = 200
	navShare      = 0.2
	navMax        = 240
	navPadX       = 11.2
	navPadY       = 17.6
	navGap        = 3.2
	navTitleX     = 9.6
	navTitleSize  = 16.8
	navTitleLine  = 23.4
	navTitleGap   = 17
	pagePadX      = 20.8
	pagePadTop    = 17.6
	pagePadBottom = 6.4
	footerPadY    = 12
	footerPadX    = 20.8
)

// Hooks is what the window needs from the program around it.
type Hooks struct {
	// Apply makes the theme, size and language in the saved settings the ones in use.
	Apply func()
	// SignOut leaves the server; the window has already closed.
	SignOut func()
	// CameraChanged is told when the camera or its quality was changed (prev is what it was), so a camera that is on moves to
	// it; done is called, on the interface's thread, with the translation key of what to say about it, or "".
	CameraChanged func(prev CameraChoice, done func(note string))
	// EncoderChanged is told when the video encoder was chosen again, so a camera or share that is on moves to it.
	EncoderChanged func()
}

type page interface {
	icon() string
	label(c *widget.Context) string
	build(c *widget.Context) widget.Component
}

// Dialog is the settings window, shown over everything as a modal.
type Dialog struct {
	Session  *app.Session
	Settings *store.Settings
	Devices  *audio.Devices
	// Desktop is the hotkeys, tray and updater the Hotkeys, Updates and Debug pages show and change.
	Desktop *desktop.Desktop
	Hooks

	pages   []page
	scrolls []widget.Scroll
	current int
	body    widget.Component
	dirty   bool
	strings *i18n.Bundle
	ctx     *widget.Context
	done    widget.Button
	picks   []func()
}

func New(session *app.Session, settings *store.Settings, devices *audio.Devices, hooks Hooks) *Dialog {
	d := &Dialog{Session: session, Settings: settings, Devices: devices, Hooks: hooks, dirty: true, current: 2}
	d.pages = []page{newProfile(d), newSecurity(d), newAppearance(d), newVoice(d), newSounds(d), newHotkeys(d), newUpdates(d), newDebug(d)}
	d.scrolls = make([]widget.Scroll, len(d.pages))
	for i := range d.pages {
		d.picks = append(d.picks, func() { d.show(i) })
	}
	for i := range d.scrolls {
		d.scrolls[i].Bar = true
	}
	d.done = widget.Button{Variant: widget.Primary}
	return d
}

func (d *Dialog) invalidate() { d.dirty = true }

func (d *Dialog) save() {
	d.Settings.Save()
	d.invalidate()
}

func (d *Dialog) apply() {
	d.Settings.Save()
	d.ctx.Post(d.Apply)
	d.invalidate()
}

// Page numbers, for Show.
const (
	PageVoice  = 3
	PageSounds = 4
)

// Show opens the window on a page.
func (d *Dialog) Show(page int) { d.show(page) }

func (d *Dialog) show(i int) {
	d.current = i
	d.invalidate()
}

func (d *Dialog) Draw(c *widget.Context, bounds geom.Rect) {
	d.ctx = c
	c.Layer(d)
	if c.EscapeFor(d) {
		c.CloseModal()
		return
	}
	if c.Strings != d.strings {
		d.strings, d.dirty = c.Strings, true
	}
	c.Paint.Fill(bounds, 0, color.RGBA{A: backdrop})

	edge := c.Hairline()
	card := cardRect(bounds)
	c.Paint.Fill(card, cardRadius, c.Theme.Surface2)
	inner := card.InsetAll(edge)
	nav := geom.Rect{X: inner.X, Y: inner.Y, W: min(max(inner.W*navShare, navMin), navMax), H: inner.H}
	d.drawNav(c, nav)
	c.Paint.Stroke(card, cardRadius, edge, theme.WithAlpha(c.Theme.Tint, cardEdgeAlpha))

	main := geom.Rect{X: nav.Right(), Y: inner.Y, W: inner.W - nav.W, H: inner.H}
	footer := d.drawFooter(c, main)
	if d.dirty {
		d.body, d.dirty = widget.Padded{Left: pagePadX, Top: pagePadTop, Right: pagePadX, Bottom: pagePadBottom, Child: d.pages[d.current].build(c)}, false
	}
	d.scrolls[d.current].Child = d.body
	d.scrolls[d.current].Draw(c, geom.Rect{X: main.X, Y: main.Y, W: main.W, H: footer.Y - main.Y})
}

func cardRect(bounds geom.Rect) geom.Rect {
	w := min(min(max(bounds.W*widthShare, widthMin), widthMax), bounds.W*widthCap)
	h := min(min(max(bounds.H*heightShare, heightMin), heightMax), bounds.H*heightCap)
	return geom.Rect{X: bounds.X + (bounds.W-w)/2, Y: bounds.Y + (bounds.H-h)/2, W: w, H: h}
}

func (d *Dialog) drawNav(c *widget.Context, nav geom.Rect) {
	c.Paint.Fill(nav, cardRadius, c.Theme.Surface)
	c.Paint.Fill(geom.Rect{X: nav.X + cardRadius, Y: nav.Y, W: nav.W - cardRadius, H: nav.H}, 0, c.Theme.Surface)
	c.Paint.Fill(geom.Rect{X: nav.Right() - c.Hairline(), Y: nav.Y, W: c.Hairline(), H: nav.H}, 0, c.Theme.Border)

	x, width := nav.X+navPadX, nav.W-2*navPadX-c.Hairline()
	y := nav.Y + navPadY
	c.Paint.Text(c.T("settings.settings"), x+navTitleX, y, navTitleLine, paint.TextStyle{Size: navTitleSize, Weight: paint.Semibold}, c.Theme.Text)
	y += navTitleLine + navTitleGap
	for i, p := range d.pages {
		item := widget.NavItem{Icon: p.icon(), Label: p.label(c), Selected: i == d.current, OnClick: d.picks[i]}
		h := item.Measure(c, width).H
		item.Draw(c, geom.Rect{X: x, Y: y, W: width, H: h})
		y += h + navGap
	}
}

// drawFooter draws the line and the Done button along the bottom of main and returns the footer's area.
func (d *Dialog) drawFooter(c *widget.Context, main geom.Rect) geom.Rect {
	d.done.Label = c.T("devices_close.done")
	if d.done.OnClick == nil {
		d.done.OnClick = c.CloseModal
	}
	size := d.done.Measure(c, 0)
	footer := geom.Rect{X: main.X, Y: main.Bottom() - size.H - 2*footerPadY, W: main.W, H: size.H + 2*footerPadY}
	c.Paint.Fill(geom.Rect{X: footer.X, Y: footer.Y - c.Hairline(), W: footer.W, H: c.Hairline()}, 0, c.Theme.Border)
	d.done.Draw(c, geom.Rect{X: footer.Right() - footerPadX - size.W, Y: footer.Y + footerPadY, W: size.W, H: size.H})
	footer.Y -= c.Hairline()
	return footer
}
