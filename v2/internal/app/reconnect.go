package app

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/hclient"
)

// EndKind is why a session ended without being asked to.
type EndKind int

const (
	// EndKicked is the server putting this account out: Reason is "kicked", "banned" or "account removed".
	EndKicked EndKind = iota
	// EndExpired is the session token no longer being good, and no way to get a new one.
	EndExpired
	// EndClosed is the connection being over for any other reason.
	EndClosed
)

// Ended says a session is over because the server ended it, not the person.
type Ended struct {
	Kind   EndKind
	Reason string
}

// Change names what a subscriber is told has changed in the session's picture of the server.
type Change string

const (
	ChangeRoles  Change = "roles"
	ChangeBadges Change = "badges"
	// ChangeServer is the server's own settings: name, logo, banner, limits.
	ChangeServer Change = "server"
	// ChangeResync is everything having been read again after the connection came back.
	ChangeResync Change = "resync"
)

// linkState is what the session knows of the state of its connection and who wants to hear of changes.
type linkState struct {
	down     atomic.Bool
	rejected atomic.Bool
	kicked   atomic.Pointer[string]

	mu   sync.Mutex
	subs map[int]func(Change)
	next int
}

// Reconnecting is whether the connection to the server is down and being dialled again.
func (s *Session) Reconnecting() bool { return s.link.down.Load() }

// Subscribe has fn called, from the connection's goroutine and so briefly, whenever the roles, the badges or the
// server's settings change, or everything has been read again after a reconnect. Session.State has the new values by
// then. The returned function stops it.
func (s *Session) Subscribe(fn func(Change)) (cancel func()) {
	l := &s.link
	l.mu.Lock()
	if l.subs == nil {
		l.subs = map[int]func(Change){}
	}
	id := l.next
	l.next++
	l.subs[id] = fn
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		delete(l.subs, id)
		l.mu.Unlock()
	}
}

func (s *Session) publish(c Change) {
	l := &s.link
	l.mu.Lock()
	subs := make([]func(Change), 0, len(l.subs))
	for _, fn := range l.subs {
		subs = append(subs, fn)
	}
	l.mu.Unlock()
	for _, fn := range subs {
		fn(c)
	}
}

// connectionEvent follows the connection: down, up again, refused, and the server putting this account out.
func (s *Session) connectionEvent(msg hclient.Message) {
	switch msg.Type {
	case hclient.EventDown:
		s.logf("the connection to the server was lost: dialling again")
		s.link.down.Store(true)
		s.changed()
	case hclient.EventUp:
		var hello hclient.Hello
		if msg.Decode(&hello) != nil {
			return
		}
		s.logf("the connection to the server is back")
		s.link.down.Store(false)
		s.link.rejected.Store(false)
		s.resync(hello)
	case hclient.EventRejected:
		s.link.rejected.Store(true)
	case "kicked":
		var m struct {
			Reason string `json:"reason"`
		}
		_ = msg.Decode(&m)
		s.link.kicked.Store(&m.Reason)
	}
}

// ended is called when the connection is over for good; the person is told unless they closed the session themselves.
func (s *Session) ended() {
	if s.ctx.Err() != nil {
		return
	}
	end := Ended{Kind: EndClosed}
	switch reason := s.link.kicked.Load(); {
	case reason != nil:
		end = Ended{Kind: EndKicked, Reason: *reason}
	case s.link.rejected.Load():
		end.Kind = EndExpired
	}
	s.logf("the session ended (%d %s)", end.Kind, end.Reason)
	s.leaveLocal()
	s.stopAudio()
	s.link.down.Store(false)
	s.changed()
	if s.opt.OnEnded != nil {
		s.opt.OnEnded(end)
	}
}

// resync takes everything the server says at hello again, as a client that was away has missed every change in between.
func (s *Session) resync(h hclient.Hello) {
	s.mu.Lock()
	if h.User.ID != 0 {
		s.me = h.User
	}
	s.roles, s.badges = hclient.SortRoles(h.Roles), hclient.SortBadges(h.Badges)
	s.channels, s.groups = h.Channels, h.Groups
	s.rosters = h.Rosters
	if s.rosters == nil {
		s.rosters = map[int][]hclient.Member{}
	}
	s.presence = h.Presence
	if h.Status != "" {
		s.status = h.Status
	}
	s.voiceCap = h.VoiceCap
	away := s.away
	s.rev++
	s.mu.Unlock()
	s.chat.SetUnread(h.Unread)
	s.chat.SetCanPin(h.Can("messages.pin"))
	s.chat.SetForumRights(h.Can("posts.pin"), h.Can("posts.delete"))
	s.changed()
	s.publish(ChangeResync)
	go s.rejoin()
	go s.reread(away)
}

// VoiceCap is how many people a voice channel holds at most, or 0 when the server has not said.
func (s *Session) VoiceCap() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.voiceCap
}

// reread fetches what hello does not carry: the roster of accounts, the server's settings, the clips, and the messages.
func (s *Session) reread(away bool) {
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	if away {
		_, _ = s.rt.Request(ctx, "presence:away", map[string]any{"away": true})
	}
	if members, err := s.client.Accounts(ctx); err == nil {
		s.mu.Lock()
		s.members = members
		s.rev++
		s.mu.Unlock()
		s.changed()
	}
	s.loadServer(ctx)
	s.publish(ChangeServer)
	s.loadClips()
	s.chat.Resync()
	s.dm.Resync(ctx)
}

// rejoin goes back into the voice channel the person was in: the server forgot them with the socket, and with it the
// member id the media paths are named by, so the microphone, the camera and the share are sent again under the new one.
func (s *Session) rejoin() {
	s.mu.Lock()
	old := s.joined
	s.mu.Unlock()
	if old == nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
	defer cancel()
	j, err := s.rt.Join(ctx, old.ChannelID, "")
	if err != nil {
		s.logf("could not go back into channel %d: %v", old.ChannelID, err)
		s.leaveLocal()
		s.stopAudio()
		s.changed()
		return
	}
	jctx, jcancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	if s.joined != old {
		s.mu.Unlock()
		jcancel()
		_ = s.rt.Leave(ctx, j.ChannelID)
		return
	}
	previous := s.joinCtx
	s.joined, s.joinCtx = &j, jcancel
	s.rosters[j.ChannelID] = j.Roster
	s.rev++
	muted, deaf := s.muted, s.deafened
	restarts := slices.DeleteFunc([]*shareState{s.share, s.cam}, func(st *shareState) bool { return st == nil })
	s.mu.Unlock()
	if previous != nil {
		previous()
	}
	s.logf("rejoined channel %d as member %d (%d in the room)", j.ChannelID, j.Mid, len(j.Roster))
	s.musicJoined(jctx, j)
	if muted || deaf {
		_ = s.rt.Mute(ctx, j.ChannelID, muted || deaf, deaf)
	}
	go s.runMic(jctx, j.ChannelID)
	go s.refreshTokens(jctx, j.ChannelID, time.Duration(j.ExpiresInMs)*time.Millisecond)
	for _, st := range restarts {
		select {
		case st.restart <- struct{}{}:
		default:
		}
	}
	s.reconcile()
	s.changed()
}
