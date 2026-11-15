package channels

import (
	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/screens/serveradmin"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/widget"
)

const volumeMaxPeer = 350

// peerMenu is what a right-click on somebody in a voice channel offers: how loud they are for you, and for those who may, muting
// and moving them.
type peerMenu struct {
	menu    widget.ContextMenu
	move    widget.ContextMenu
	volume  widget.VolumeRow
	channel int
	mid     int
	user    int
	name    string
	x, y    float32
	opened  bool
	loaded  bool
}

func rosterMember(st *app.State, channelID, mid int) (hclient.Member, bool) {
	for _, m := range st.Rosters[channelID] {
		if m.Mid == mid {
			return m, true
		}
	}
	return hclient.Member{}, false
}

// displayName is what somebody is called here: their display name, else the nickname the room knows them by.
func displayName(c *widget.Context, user int, nickname string) string {
	if c.People != nil {
		if e := c.People.ByID(user); e != nil {
			return e.Name()
		}
	}
	return nickname
}

// openPeerMenu opens the menu for the person holding a slot of a voice channel, at the pointer. Slots are handed on when somebody
// leaves, so it keeps the slot and looks the person up each time it acts.
func (s *Screen) openPeerMenu(c *widget.Context, channelID, mid int) {
	st := s.Session.State()
	member, ok := rosterMember(st, channelID, mid)
	if !ok || channelID == st.Joined && mid == st.MyMid {
		return
	}
	p := &s.peer
	p.channel, p.mid, p.user = channelID, mid, member.UserID
	p.name = displayName(c, member.UserID, member.Nickname)
	p.x, p.y = c.In.MouseX, c.In.MouseY
	if !s.buildPeerMenu(c, st, member) {
		return
	}
	p.menu.OpenAt(p.x, p.y)
	p.opened = true
}

func (s *Screen) buildPeerMenu(c *widget.Context, st *app.State, member hclient.Member) bool {
	p := &s.peer
	var items []widget.MenuItem
	if p.channel == st.Joined {
		items = append(items, s.peerAudioItems(c)...)
	}
	rank := 0
	if c.People != nil {
		if e := c.People.ByID(p.user); e != nil {
			rank = hclient.ActorOf(hclient.User{Role: e.Role, Roles: e.Roles}, st.Roles).Rank
		}
	}
	var admin []widget.MenuItem
	if (st.Actor.Can("users.mute") || st.Actor.Can("users.kick")) && st.Actor.Rank > rank {
		if st.Actor.Can("users.mute") {
			label, icon := c.T("app.force_mute"), "microphone-slash"
			if member.ForceMuted {
				label = c.T("app.unmute")
			}
			admin = append(admin, widget.MenuItem{Icon: icon, Label: label, OnPick: s.toggleForceMute})
		}
		if st.Actor.Can("users.kick") {
			admin = append(admin, widget.MenuItem{Icon: "sign-out", Label: c.T("members.move"), OnPick: func() { s.openMoveMenu(c) }})
		}
	}
	if len(items) > 0 && len(admin) > 0 {
		items = append(items, widget.MenuItem{Rule: true})
	}
	items = append(items, admin...)
	if p.user != st.Me.ID && serveradmin.MembersAllowed(st.Actor) {
		if len(items) > 0 {
			items = append(items, widget.MenuItem{Rule: true})
		}
		user := p.user
		items = append(items, widget.MenuItem{Icon: "key", Label: c.T("server_admin.manage_member"), OnPick: func() {
			s.OnServerDialog(serveradmin.Target{Tab: serveradmin.TabMembers, Kind: "member", ID: user})
		}})
	}
	if len(items) == 0 {
		return false
	}
	p.menu.Head, p.menu.HeadID, p.menu.Items = p.name, p.user, items
	return true
}

func (s *Screen) peerAudioItems(c *widget.Context) []widget.MenuItem {
	p := &s.peer
	pref := s.Session.PeerPref(p.user)
	label := c.T("app.mute_for_me")
	if pref.Muted {
		label = c.T("app.unmute_for_me")
	}
	v := &p.volume
	v.Max, v.Value, v.Muted, v.MutedText = volumeMaxPeer, int(pref.Gain*100+0.5), pref.Muted, c.T("app.muted_2")
	v.OnChange = func(percent int) { s.keepPeer(s.Session.SetPeerGain(p.user, float64(percent)/100)) }
	v.OnSettle = func(int) { s.Settings.Save() }
	v.Reset()
	return []widget.MenuItem{
		{Icon: "speaker-slash", Label: label, On: pref.Muted, OnPick: func() { s.toggleLocalMute(c) }},
		{Volume: v},
	}
}

// keepPeer remembers how loud somebody is, in the settings file the next time it is saved.
func (s *Screen) keepPeer(pref app.PeerPref) {
	s.peer.volume.Muted = pref.Muted
	s.Settings.SetPeerVolume(s.Server.URL, s.peer.user, store.PeerVolume{Gain: pref.Gain, Muted: pref.Muted})
}

// toggleLocalMute silences or brings back somebody for this listener, and keeps the menu open on the new state.
func (s *Screen) toggleLocalMute(c *widget.Context) {
	p := &s.peer
	pref := s.Session.SetPeerMuted(p.user, !s.Session.PeerPref(p.user).Muted)
	s.keepPeer(pref)
	s.Settings.Save()
	st := s.Session.State()
	if member, ok := rosterMember(st, p.channel, p.mid); ok && s.buildPeerMenu(c, st, member) {
		p.menu.OpenAt(p.x, p.y)
	}
}

func (s *Screen) toggleForceMute() {
	p := &s.peer
	live, ok := rosterMember(s.Session.State(), p.channel, p.mid)
	if !ok {
		return
	}
	channel, mid := p.channel, p.mid
	go func() { s.fail(s.Session.ForceMute(channel, mid, !live.ForceMuted)) }()
}

// openMoveMenu lists where somebody can be sent: every other voice channel, or out of voice.
func (s *Screen) openMoveMenu(c *widget.Context) {
	p := &s.peer
	user := p.user
	items := make([]widget.MenuItem, 0, len(s.seen.channels)+1)
	for _, ch := range s.seen.channels {
		if ch.Kind != "voice" || ch.ID == p.channel {
			continue
		}
		id := ch.ID
		items = append(items, widget.MenuItem{Icon: "speaker-high", Label: ch.Name, OnPick: func() { s.movePerson(user, id) }})
	}
	items = append(items, widget.MenuItem{Icon: "phone-disconnect", Label: c.T("voice_leave.disconnect"), Danger: true, OnPick: func() { s.movePerson(user, 0) }})
	p.move.Head, p.move.HeadID, p.move.Items = p.name, p.user, items
	p.move.OpenAt(p.x, p.y)
}

func (s *Screen) movePerson(user, to int) {
	go func() { s.fail(s.Session.MovePerson(user, to)) }()
}

// loadPeerVolumes hands the session what was kept of how loud everybody is, once it knows who is signed in.
func (s *Screen) loadPeerVolumes() {
	p := &s.peer
	if p.loaded {
		return
	}
	p.loaded = true
	saved := s.Settings.PeerVolumesOf(s.Server.URL)
	prefs := make(map[int]app.PeerPref, len(saved))
	for user, v := range saved {
		prefs[user] = app.PeerPref{Gain: v.Gain, Muted: v.Muted}
	}
	s.Session.LoadPeerPrefs(prefs)
	s.loadStreamVolumes()
}

// showPeerMenus draws the menus while open, and puts a volume that was still settling away when the menu closed.
func (s *Screen) showPeerMenus(c *widget.Context) {
	p := &s.peer
	s.updatePersonDrag(c)
	p.menu.Show(c)
	p.move.Show(c)
	if p.opened && !p.menu.IsOpen() && !p.move.IsOpen() {
		p.opened = false
		p.volume.Flush()
	}
}
