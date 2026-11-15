package shell

import (
	"context"
	"sync/atomic"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/audio"
	"harmony/v2/internal/faces"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/hub"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/screens/channels"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

// heldCall is a call that goes on while another server is on screen: its whole session is kept, with the screen it was shown on.
type heldCall struct {
	url     string
	session *app.Session
	screen  *channels.Screen
}

// serverSet is every saved server at once: the one on screen is Shell.session, a call on another is held, and the rest are
// kept connected by the hub for what their bubbles say.
type serverSet struct {
	hub  *hub.Hub
	held *heldCall
	// signed is which saved servers have a session token; nil until the secret store has been read.
	signed map[string]bool
	// looks are the pictures of each saved server, read from its health answer.
	looks map[string]*serverLook
	menu  widget.ContextMenu
	bar   widget.CallBar
	card  cardCache
	where callText

	// foreground is the session on screen, lead the one that hotkeys and sounds belong to (the held call when there is one).
	foreground atomic.Pointer[app.Session]
	lead       atomic.Pointer[app.Session]
}

type callText struct {
	state   *app.State
	strings *i18n.Bundle
	down    bool
	text    string
}

func (sh *Shell) startServers() {
	s := &sh.servers
	s.hub = hub.New(hub.Options{
		Credentials: func(url string) (string, string) {
			c := store.LoadCredentials(url)
			return c.Token, c.Door
		},
		Relogin:   sh.relogin,
		OnChange:  redraw.Request,
		OnMention: sh.backgroundMention,
		OnLocked: func(url string) {
			go func() {
				_ = store.UpdateCredentials(url, func(c *store.Credentials) { c.Token = "" })
				sh.context.Post(sh.refreshSignIns)
			}()
		},
	})
	sh.rail.OnMenu, sh.rail.OnMove, sh.rail.Card = sh.railMenu, sh.moveServer, sh.serverCard
	sh.refreshSignIns()
}

// refreshSignIns reads the secret store, off the interface's thread, for which saved servers have a session to use.
type serverLook struct{ logo, banner widget.ServerLogo }

func (sh *Shell) refreshSignIns() {
	urls := make([]string, len(sh.settings.Servers))
	for i, server := range sh.settings.Servers {
		urls[i] = server.URL
	}
	go func() {
		signed := make(map[string]bool, len(urls))
		looks := make(map[string]*serverLook, len(urls))
		for _, url := range urls {
			creds := store.LoadCredentials(url)
			signed[url] = creds.Token != ""
			looks[url] = readLook(url, creds.Door)
		}
		sh.context.Post(func() {
			sh.servers.signed, sh.servers.looks = signed, looks
			sh.syncHub()
		})
	}()
}

// syncHub keeps connected exactly the saved servers that have a session, want keeping and are neither on screen nor holding a call.
func (sh *Shell) syncHub() {
	s := &sh.servers
	var wanted []string
	for _, server := range sh.settings.Servers {
		if len(wanted) == hub.MaxLive {
			break
		}
		if !s.signed[server.URL] || server.NoBackground || server.URL == sh.open || s.held != nil && s.held.url == server.URL {
			continue
		}
		wanted = append(wanted, server.URL)
	}
	s.hub.Sync(wanted)
}

// syncLead tells the desktop which session its hotkeys, sounds and idle watch belong to: the held call, else the one on screen.
func (sh *Shell) syncLead() {
	s := &sh.servers
	lead, url := sh.session, sh.open
	if s.held != nil {
		lead, url = s.held.session, s.held.url
	}
	s.foreground.Store(sh.session)
	s.lead.Store(lead)
	sh.desktop.SetSession(lead, url)
}

// idleAway is the computer being left alone, or touched again: every server but the one in a call hears it.
func (sh *Shell) idleAway(idle bool) {
	s := &sh.servers
	s.hub.SetAway(idle)
	if fg := s.foreground.Load(); fg != nil && fg != s.lead.Load() {
		fg.SetAway(idle && !fg.InVoice())
	}
}

// backgroundMention is the cue for a message naming the person on a server that is not on screen.
func (sh *Shell) backgroundMention(string, hclient.ChatMessage) {
	if !sh.settings.MentionSound {
		return
	}
	if session := sh.servers.lead.Load(); session != nil {
		session.PreviewCue(audio.CueMention)
	}
}

// demote puts the server on screen away: a call on it goes on, anything else is closed and left to the hub.
func (sh *Shell) demote() {
	session := sh.session
	if session == nil {
		return
	}
	if session.InVoice() {
		sh.dropHeld()
		session.Chat().SetOpen(0)
		sh.servers.held = &heldCall{url: sh.open, session: session, screen: sh.channels}
		sh.session, sh.open, sh.channels = nil, "", nil
		sh.syncLead()
	} else {
		sh.signOut()
	}
	sh.syncHub()
}

// dropHeld ends the held call's session.
func (sh *Shell) dropHeld() {
	h := sh.servers.held
	if h == nil {
		return
	}
	sh.servers.held = nil
	go h.session.Close()
	sh.syncLead()
	sh.syncHub()
}

// swapHeld brings the held call's server on screen, as it was left, and puts the one on screen away.
func (sh *Shell) swapHeld() {
	h := sh.servers.held
	sh.servers.held = nil
	sh.demote()
	sh.session, sh.open, sh.channels = h.session, h.url, h.screen
	sh.context.People, sh.context.Faces = h.session.People(), h.session.Faces()
	sh.screen = h.screen
	sh.syncLead()
	sh.syncHub()
}

// heldEnded is the server ending the session of a held call.
func (sh *Shell) heldEnded(end app.Ended) {
	url := sh.servers.held.url
	if end.Kind != app.EndClosed {
		go func() {
			_ = store.UpdateCredentials(url, func(c *store.Credentials) { c.Token = "" })
			sh.context.Post(sh.refreshSignIns)
		}()
	}
	sh.dropHeld()
}

// serverJump opens the server whose number was pressed with Ctrl (Command).
func (sh *Shell) serverJump(n int) {
	if n >= 1 && n <= len(sh.settings.Servers) {
		sh.selectServer(sh.settings.Servers[n-1].URL)
	}
}

func (sh *Shell) closeServers() {
	if h := sh.servers.held; h != nil {
		sh.servers.held = nil
		h.session.Close()
	}
	sh.servers.hub.Close()
}

// tick drops a held call that is over, or that another call replaced.
func (sh *Shell) tick() {
	if h := sh.servers.held; h != nil && (!h.session.InVoice() || sh.session != nil && sh.session.InVoice()) {
		sh.dropHeld()
	}
}

func (sh *Shell) syncRail() {
	sh.tick()
	s := &sh.servers
	r := sh.rail
	r.Servers = r.Servers[:0]
	private := sh.channels != nil && sh.channels.PrivateOpen()
	r.HomeDisabled = sh.channels == nil || !sh.channels.PrivateAvailable()
	r.HomeCurrent, r.HomeUnread = private, 0
	if sh.channels != nil {
		r.HomeUnread = sh.channels.PrivateUnread()
	}
	for _, server := range sh.settings.Servers {
		rs := widget.RailServer{URL: server.URL, Name: server.Title(), Current: server.URL == sh.open && !private}
		if look := s.looks[server.URL]; look != nil {
			rs.Logo = look.logo
		}
		switch {
		case server.URL == sh.open:
			if sh.session.Reconnecting() {
				rs.State = widget.RailOffline
			}
			rs.InCall = sh.session.State().Joined != 0
		case s.held != nil && s.held.url == server.URL:
			unread, mentions := s.held.session.Chat().UnreadTotals()
			rs.Unread, rs.Mentions, rs.InCall = unread > 0, mentions, true
			if s.held.session.Reconnecting() {
				rs.State = widget.RailOffline
			}
			r.HomeUnread += s.held.session.DM().Status().Unread
		case s.signed != nil && !s.signed[server.URL]:
			rs.State = widget.RailLocked
		default:
			if sum, ok := s.hub.Summary(server.URL); ok {
				rs.Unread, rs.Mentions, rs.Voice = sum.Unread > 0, sum.Mentions, sum.Voice
				switch sum.State {
				case hub.Down:
					rs.State = widget.RailOffline
				case hub.Locked:
					rs.State = widget.RailLocked
				}
				r.HomeUnread += sum.DMUnread
			}
		}
		r.Servers = append(r.Servers, rs)
	}
}

// drawCallBar draws the call bar above the screen when a call is held, and returns what is left under it.
func (sh *Shell) drawCallBar(c *widget.Context, r geom.Rect) geom.Rect {
	h := sh.servers.held
	if h == nil {
		return r
	}
	bar := &sh.servers.bar
	state := h.session.State()
	bar.Connecting = h.session.Reconnecting()
	bar.Where = sh.callText(h, state, bar.Connecting)
	bar.Muted, bar.Deafened = state.Muted, state.Deafened
	if bar.OnReturn == nil {
		bar.OnReturn = func() {
			if held := sh.servers.held; held != nil {
				sh.selectServer(held.url)
			}
		}
		bar.OnMute = func() {
			if held := sh.servers.held; held != nil {
				held.session.SetMuted(!held.session.State().Muted)
			}
		}
		bar.OnDeafen = func() {
			if held := sh.servers.held; held != nil {
				held.session.SetDeafened(!held.session.State().Deafened)
			}
		}
		bar.OnLeave = func() {
			if held := sh.servers.held; held != nil {
				go held.session.Leave()
			}
		}
	}
	height := bar.Height(c)
	bar.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: height})
	return geom.Rect{X: r.X, Y: r.Y + height, W: r.W, H: r.H - height}
}

// callText is what the bar says, rebuilt only when what it is made from changed.
func (sh *Shell) callText(h *heldCall, state *app.State, down bool) string {
	w := &sh.servers.where
	if w.state == state && w.strings == sh.strings() && w.down == down {
		return w.text
	}
	t := sh.strings()
	channel := ""
	for _, ch := range state.Channels {
		if ch.ID == state.Joined {
			channel = ch.Name
		}
	}
	name := state.ServerName
	if saved, ok := sh.settings.Server(h.url); ok && name == "" {
		name = saved.Title()
	}
	lead := t.T("app.voice_connected")
	if down {
		lead = t.T("app.reconnecting")
	}
	*w = callText{state: state, strings: t, down: down, text: lead + " · " + t.T("rail.call_in", "channel", channel, "server", name)}
	return w.text
}

// railMenu opens the menu of a server's bubble.
func (sh *Shell) railMenu(url string, x, y float32) {
	saved, ok := sh.settings.Server(url)
	if !ok {
		return
	}
	t := sh.strings()
	open := url == sh.open
	m := &sh.servers.menu
	m.Head, m.NameOnly = saved.Title(), true
	m.Items = m.Items[:0]
	if !open {
		m.Items = append(m.Items, widget.MenuItem{Label: t.T("rail.menu_open"), OnPick: func() { sh.selectServer(url) }})
	}
	if open || sh.servers.signed[url] {
		m.Items = append(m.Items, widget.MenuItem{Label: t.T("rail.menu_sign_out"), OnPick: func() { sh.signOutServer(url) }})
	}
	if !open {
		label := t.T("rail.menu_keep_live_off")
		if saved.NoBackground {
			label = t.T("rail.menu_keep_live_on")
		}
		m.Items = append(m.Items, widget.MenuItem{Label: label, OnPick: func() { sh.toggleKeepLive(url) }})
	}
	m.Items = append(m.Items, widget.MenuItem{Label: t.T("rail.menu_forget"), Danger: true, OnPick: func() { sh.askForget(url, saved.Title()) }})
	m.OpenAt(x, y)
}

func (sh *Shell) toggleKeepLive(url string) {
	for i := range sh.settings.Servers {
		if sh.settings.Servers[i].URL == url {
			sh.settings.Servers[i].NoBackground = !sh.settings.Servers[i].NoBackground
		}
	}
	sh.settings.Save()
	sh.syncHub()
}

func (sh *Shell) moveServer(url, to string, after bool) {
	sh.settings.MoveServer(url, to, after)
	sh.settings.Save()
	redraw.Request()
}

// signOutServer ends the session on a server and keeps the remembered password for the next sign-in.
func (sh *Shell) signOutServer(url string) {
	if url == sh.open {
		sh.leave()
		return
	}
	if h := sh.servers.held; h != nil && h.url == url {
		sh.dropHeld()
	}
	if sh.servers.signed != nil {
		sh.servers.signed[url] = false
	}
	sh.syncHub()
	go func() {
		revokeSaved(url, false)
		sh.context.Post(sh.refreshSignIns)
	}()
}

func (sh *Shell) askForget(url, name string) {
	c := sh.context
	c.OpenModal(&widget.Prompt{
		Title: c.T("rail.forget_title", "name", name), Text: c.T("rail.forget_text"), OK: c.T("rail.forget_ok"), Cancel: c.T("app.cancel"),
		OnCancel: c.CloseModal,
		OnSubmit: func([]string) {
			c.CloseModal()
			sh.forgetServer(url)
		},
	})
}

// forgetServer takes a server off the rail with its saved sign-in.
func (sh *Shell) forgetServer(url string) {
	wasOpen := url == sh.open
	if wasOpen {
		sh.forgetSession(sh.session, url)
		sh.signOut()
	}
	if h := sh.servers.held; h != nil && h.url == url {
		sh.dropHeld()
	}
	sh.settings.Forget(url)
	sh.settings.Save()
	go revokeSaved(url, true)
	sh.refreshSignIns()
	sh.syncHub()
	if wasOpen {
		sh.showConnect(sh.settings.LastServer())
	}
}

// revokeSaved ends the saved session of a server on the server and forgets it here; with all, the remembered password goes too.
func revokeSaved(url string, all bool) {
	creds := store.LoadCredentials(url)
	if all {
		_ = store.ForgetCredentials(url)
	} else {
		_ = store.UpdateCredentials(url, func(c *store.Credentials) { c.Token = "" })
	}
	if creds.Token == "" {
		return
	}
	client := hclient.New(url, creds.Door, false)
	client.Token = creds.Token
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = client.Logout(ctx)
}

// readLook asks a server for the hashes of its logo and banner and makes the stores that fetch them; a server that does not answer has none.
func readLook(url, door string) *serverLook {
	client := hclient.New(url, door, false)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	health, err := client.Health(ctx)
	if err != nil {
		return nil
	}
	return &serverLook{
		logo:   widget.ServerLogo{Hash: health.Logo, Src: faces.ServerPicture(url, door, "/api/server/logo", client.HTTP)},
		banner: widget.ServerLogo{Hash: health.Banner, Src: faces.ServerPicture(url, door, "/api/server/banner", client.HTTP)},
	}
}
