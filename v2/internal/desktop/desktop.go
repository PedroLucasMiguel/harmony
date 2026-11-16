// Package desktop is Harmony's part of the computer around the window: the global hotkeys, the tray icon and its menu, the notifications for a window out of sight, the idle watch that tells the server when nobody is there, and the updater.
package desktop

import (
	"sync"
	"sync/atomic"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hotkey"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/notify"
	"harmony/v2/internal/store"
	"harmony/v2/internal/tray"
	"harmony/v2/internal/updater"
)

// Window is what the desktop needs from the window; the funcs are called from any goroutine.
type Window struct {
	// Show brings the window back and in front, Hide puts it away (the program goes on in the tray).
	Show, Hide func()
	// Focused says whether the window is the one in front.
	Focused func() bool
	// Quit ends the program for good.
	Quit func()
}

// Options is what a Desktop is made from.
type Options struct {
	Settings *store.Settings
	Window   Window
	// Strings is the language in use now.
	Strings func() *i18n.Bundle
	// Post runs fn on the interface's thread; Redraw asks for a frame.
	Post   func(fn func())
	Redraw func()
	// Open is told to show what a clicked notification was about.
	Open func(n app.Notice)
	// ToggleCamera is the camera hotkey.
	ToggleCamera func()
	// Away is told, from the idle watch's goroutine, whether the computer is being left alone, so that servers other than the open one hear it.
	Away func(away bool)
	// TrayColours is the palette the tray's menu is drawn in; nil leaves it to the system.
	TrayColours func() tray.Colours
}

type Desktop struct {
	Updater *updater.Updater

	opt     Options
	hot     hotkey.Manager
	session atomic.Pointer[app.Session]
	tray    *tray.Tray
	server  string

	mu      sync.Mutex
	results map[string]hotkey.Result
	paused  bool

	idleStop chan struct{}

	look     trayKey
	hinted   bool
	quitting atomic.Bool
}

// New brings the desktop up. On a Mac it must run on the thread the window runs on, because the menu bar icon is made here.
func New(opt Options) *Desktop {
	d := &Desktop{opt: opt, Updater: updater.New(), results: map[string]hotkey.Result{}}
	d.hot.OnEvent = d.fire
	d.Updater.OnChange = opt.Redraw
	d.Updater.Relaunch = func() { d.Quit() }
	updater.Remove()
	d.startTray()
	d.Updater.Start()
	return d
}

// Quit ends the program; the window's close button only hides it while a tray icon is there to bring it back.
func (d *Desktop) Quit() {
	d.quitting.Store(true)
	d.opt.Window.Quit()
}

// Close lets go of everything.
func (d *Desktop) Close() {
	d.SetSession(nil, "")
	d.hot.Close()
	d.tray.Close()
}

// HideOnClose says whether the window's close button should hide it: it should while there is a tray icon to get it back from.
func (d *Desktop) HideOnClose() bool { return d.tray != nil && !d.quitting.Load() }

// ShowWindow brings the window back.
func (d *Desktop) ShowWindow() { d.opt.Window.Show() }

// SetSession tells the desktop which server is open now (or none): hotkeys act on it, idle time is reported to it, its mentions are notified.
func (d *Desktop) SetSession(s *app.Session, server string) {
	if d.idleStop != nil {
		close(d.idleStop)
		d.idleStop = nil
	}
	d.mu.Lock()
	d.server = server
	d.mu.Unlock()
	d.session.Store(s)
	if s != nil {
		s.SetPushToTalk(d.opt.Settings.PushToTalk)
		d.idleStop = make(chan struct{})
		go watchIdle(s, d.idleStop, d.opt.Away)
	}
	d.SyncHotkeys()
}

// Notice is a mention or private message from the open session: it becomes a system notification when the window is not in front.
func (d *Desktop) Notice(n app.Notice) {
	if d.opt.Window.Focused() {
		return
	}
	open := func() {
		d.opt.Post(func() {
			d.opt.Window.Show()
			d.opt.Open(n)
		})
	}
	_ = notify.Show(notify.Notification{Title: n.Title, Body: n.Body, OnClick: open})
}
