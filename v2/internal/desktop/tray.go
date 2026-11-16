package desktop

import (
	"harmony/v2/internal/app"
	"harmony/v2/internal/notify"
	"harmony/v2/internal/tray"
)

const iconPixels = 32

// trayKey is everything the icon, its tooltip and its menu are made from, so that nothing is touched while it is the same.
type trayKey struct {
	look     tray.Look
	mentions int
	voice    bool
	muted    bool
	deafened bool
	channel  int
	language string
	dark     bool
}

func (d *Desktop) startTray() {
	d.tray = tray.Start(tray.Options{
		Tooltip: "Harmony",
		Icon:    tray.Picture(tray.LookApp, iconPixels),
		OnOpen:  d.opt.Window.Show,
		Menu:    d.menu,
		Colours: d.opt.TrayColours,
	})
	if d.tray != nil {
		notify.Balloon = d.tray.Balloon
		d.tray.SetMenu(d.menu())
	}
}

func (d *Desktop) key() trayKey {
	k := trayKey{language: d.opt.Strings().Code()}
	if d.opt.TrayColours != nil {
		k.dark = d.opt.TrayColours().Dark()
	}
	s := d.session.Load()
	if s == nil {
		return k
	}
	st := s.State()
	k.voice, k.muted, k.deafened, k.channel = st.Joined != 0, st.Muted, st.Deafened, st.Joined
	for _, c := range st.Channels {
		k.mentions += s.Chat().Unread(c.ID).Mentions
	}
	for _, c := range s.DM().Conversations() {
		k.mentions += c.Unread
	}
	switch {
	case k.deafened && k.voice:
		k.look = tray.LookDeafened
	case k.muted && k.voice:
		k.look = tray.LookMuted
	case k.voice:
		k.look = tray.LookVoice
	case k.mentions > 0:
		k.look = tray.LookUnread
	}
	return k
}

// Update brings the tray icon, its tooltip and menu in line with the call and what is unread. It is cheap enough to call every frame.
func (d *Desktop) Update() {
	if d.tray == nil {
		return
	}
	k := d.key()
	if k == d.look {
		return
	}
	old := d.look
	d.look = k
	if k.look != old.look {
		d.tray.SetIcon(tray.Picture(k.look, iconPixels))
	}
	d.tray.SetBadge(k.mentions)
	d.tray.SetTooltip(d.tooltip(k))
	d.tray.SetMenu(d.menu())
}

func (d *Desktop) tooltip(k trayKey) string {
	t := d.opt.Strings()
	switch {
	case k.voice && k.deafened:
		return "Harmony (" + t.T("main.deafened") + ")"
	case k.voice && k.muted:
		return "Harmony (" + t.T("main.muted") + ")"
	}
	return "Harmony"
}

func (d *Desktop) menu() []tray.Item {
	t := d.opt.Strings()
	s := d.session.Load()
	voice, muted, deafened := false, false, false
	if s != nil {
		st := s.State()
		voice, muted, deafened = st.Joined != 0, st.Muted, st.Deafened
	}
	items := []tray.Item{
		{Label: t.T("main.open"), OnClick: d.opt.Window.Show},
		{Separator: true},
		{Label: t.T("main.mute"), Checked: muted, Disabled: !voice, OnClick: func() { d.toggle(func(s *app.Session) { s.SetMuted(!s.State().Muted) }) }},
		{Label: t.T("main.deafen"), Checked: deafened, Disabled: !voice, OnClick: func() { d.toggle(func(s *app.Session) { s.SetDeafened(!s.State().Deafened) }) }},
	}
	if voice {
		items = append(items, tray.Item{Label: t.T("main.disconnect"), OnClick: func() { d.toggle(func(s *app.Session) { s.Leave() }) }})
	}
	return append(items, tray.Item{Separator: true}, tray.Item{Label: t.T("main.quit"), OnClick: d.Quit})
}

func (d *Desktop) toggle(act func(*app.Session)) {
	if s := d.session.Load(); s != nil {
		act(s)
	}
	d.opt.Redraw()
}

// HideWindow puts the window away into the tray. The first time ever it says that the program goes on.
func (d *Desktop) HideWindow() {
	d.opt.Window.Hide()
	if d.opt.Settings.TrayHintShown {
		return
	}
	d.opt.Settings.TrayHintShown = true
	d.opt.Settings.Save()
	t := d.opt.Strings()
	title, body := t.T("main.still_running"), t.T("main.still_running_notice")
	_ = notify.Show(notify.Notification{Title: title, Body: body, OnClick: d.opt.Window.Show})
}
