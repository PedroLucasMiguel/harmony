// Package app is the client's behaviour without a window: sign in, join a voice channel, hear everyone, share a screen and watch one.
package app

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/chat"
	"harmony/v2/internal/dm"
	"harmony/v2/internal/faces"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/media"
	"harmony/v2/internal/people"
	"harmony/v2/internal/video"
)

type Options struct {
	Server         string
	ServerPassword string
	Insecure       bool
	Loopback       bool

	Mixer *audio.Mixer
	Mic   MicSource

	// StartSpeakers opens the sound output when a call begins.
	StartSpeakers func() error
	// StopSpeakers closes the sound output again, when only a voice message was using it.
	StopSpeakers func()
	// OnChange is called, from any goroutine, whenever something the screen shows has changed.
	OnChange func()
	// OnNotice is called, from any goroutine, for a mention or a private message worth a desktop notification (not while do not disturb is on).
	OnNotice func(Notice)
	// OnFrame is called, from a decoder's goroutine, for every picture of every watched stream; make it no more than redraw.Request.
	OnFrame func()
	// GPUFrames lets watched streams keep their pictures in graphics memory, for a window that draws them as textures (a
	// program without a window leaves it off and reads them with Frame.View).
	GPUFrames bool
	// OnEnded is called, from the connection's goroutine, when the server ended the session: the account was kicked or removed, or the session expired.
	OnEnded func(Ended)
	// Relogin is asked, from the connection's goroutine, for a new session when the server stops accepting the token; it signs in on the client again with what was remembered, and says whether it worked.
	Relogin func(ctx context.Context, client *hclient.Client) bool

	Logf func(format string, args ...any)
}

type peer struct {
	mid    int
	user   int
	nick   string
	src    *audio.Source
	cancel context.CancelFunc

	mu      sync.Mutex
	sub     *media.VoiceSubscription
	retries int
}

type Session struct {
	opt    Options
	client *hclient.Client
	rt     *hclient.RT
	engine *media.Engine
	mixer  *audio.Mixer

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	me       hclient.User
	channels []hclient.Channel
	groups   []hclient.Group
	name     string
	rosters  map[int][]hclient.Member
	joined   *hclient.Joined
	joinCtx  context.CancelFunc
	peers    map[int]*peer
	share    *shareState
	sharing  shareLive
	audio    audioPart
	cam      *shareState
	viewers  viewerSet
	starting map[string]bool
	muted    bool
	deafened bool
	rev      uint64
	snap     *State
	snapRev  uint64
	members  []hclient.Account
	presence hclient.Presence
	roles    []hclient.Role
	people   *people.Directory
	dim      *int
	dimHeld  bool
	faces    *faces.Store
	badges   []hclient.Badge
	server   hclient.ServerInfo
	micOn    bool
	mic      *audio.Mic
	cues     cueState
	ptt      pttState
	status   string
	away     bool
	link     linkState
	voiceCap int
	peerVol  peerVolumes
	unlocked map[int]bool
	ping     pingState
	micWatch micWatch

	voiceNotes voiceNotes

	decoderID   atomic.Pointer[string]
	decoderFell atomic.Bool

	micFrames chan []int16
	micFree   chan []int16
	tap       micTap
	sound     soundboard
	camera    cameraPart
	music     musicPart
	chat      *chat.Store
	dm        *dm.Session
}

type shareState struct {
	cancel context.CancelFunc
	cap    *video.Capture
	// profile is the profile-level-id the stream announces, from its first access unit.
	profile string
	frames  int64
	done    chan struct{}
	// restart is told that the room has a new member id, so the picture is sent again under it.
	restart chan struct{}
}

// Connect signs in with a name and a password and brings the session up.
func Connect(ctx context.Context, opt Options, nickname, password string) (*Session, error) {
	return open(ctx, opt, func(ctx context.Context, client *hclient.Client) error { return client.Login(ctx, nickname, password) })
}

// Resume brings the session up on a session token kept from an earlier sign-in; a token the server no longer knows is an error hclient.IsExpired recognises.
func Resume(ctx context.Context, opt Options, token string) (*Session, error) {
	return open(ctx, opt, func(ctx context.Context, client *hclient.Client) error {
		client.Token = token
		_, err := client.Me(ctx)
		return err
	})
}

func open(ctx context.Context, opt Options, authenticate func(context.Context, *hclient.Client) error) (*Session, error) {
	if opt.Logf == nil {
		opt.Logf = func(string, ...any) {}
	}
	if opt.Mixer == nil {
		opt.Mixer = audio.NewMixer()
	}
	client := hclient.New(opt.Server, opt.ServerPassword, opt.Insecure)
	if opt.Relogin != nil {
		client.Relogin = func(ctx context.Context) bool { return opt.Relogin(ctx, client) }
	}

	health, err := client.Health(ctx)
	if err != nil {
		return nil, err
	}
	if err := authenticate(ctx, client); err != nil {
		return nil, err
	}
	servers, _ := client.ICEServers(ctx)
	servers = hclient.WithoutSTUN(servers)
	var ice []webrtc.ICEServer
	for _, s := range servers {
		ice = append(ice, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	engine, err := media.New(ice, opt.Loopback, nil)
	if err != nil {
		return nil, err
	}
	rt, hello, err := hclient.Dial(ctx, client)
	if err != nil {
		return nil, err
	}

	sctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		opt: opt, client: client, rt: rt, engine: engine, mixer: opt.Mixer, ctx: sctx, cancel: cancel,
		me: hello.User, roles: hclient.SortRoles(hello.Roles), badges: hclient.SortBadges(hello.Badges), channels: hello.Channels, groups: hello.Groups, name: health.Name, rosters: hello.Rosters, presence: hello.Presence, peers: map[int]*peer{}, starting: map[string]bool{},
		micFrames: make(chan []int16, 100),
	}
	s.startMic()
	if s.rosters == nil {
		s.rosters = map[int][]hclient.Member{}
	}
	if client.User.Nickname != "" {
		s.me = client.User
	}
	s.members, _ = client.Accounts(ctx)
	s.people, s.faces = people.New(), faces.New(client.Download)
	s.startSoundboard(hello.IsAdmin())
	s.chat = chat.New(client, rt, s.changed)
	s.chat.SetUnread(hello.Unread)
	s.status = hello.Status
	s.chat.OnMention = s.mentioned
	s.chat.SetCanPin(hello.Can("messages.pin"))
	s.chat.SetForumRights(hello.Can("posts.pin"), hello.Can("posts.delete"))
	s.startDM()
	s.startMusic()
	go s.eventLoop()
	go s.loadServer(sctx)
	return s, nil
}

// SetDisplayName changes the name everybody on the server sees for this account; empty goes back to the username.
func (s *Session) SetDisplayName(ctx context.Context, name string) error {
	user, err := s.client.SetDisplayName(ctx, name)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.me = user
	s.members = append([]hclient.Account(nil), s.members...)
	for i := range s.members {
		if s.members[i].ID == user.ID {
			s.members[i].DisplayName = user.DisplayName
		}
	}
	s.rev++
	s.mu.Unlock()
	s.changed()
	return nil
}

// ServerName is what the server calls itself, empty when it has no name.
func (s *Session) ServerName() string { return s.name }

// Client is the signed-in HTTP client, for the parts of the app that talk to the server without the call.
func (s *Session) Client() *hclient.Client { return s.client }

// Chat is the text channels' messages.
func (s *Session) Chat() *chat.Store { return s.chat }

// DM is the private conversations of this account on this server.
func (s *Session) DM() *dm.Session { return s.dm }

func (s *Session) changed() {
	if s.opt.OnChange != nil {
		s.opt.OnChange()
	}
}

// startAudio opens the sound output and the microphone for a call; a microphone that cannot be opened sends silence.
func (s *Session) startAudio() {
	if s.opt.StartSpeakers != nil {
		if err := s.opt.StartSpeakers(); err != nil {
			s.logf("sound output unavailable: %v", err)
		}
	}
	s.mu.Lock()
	if s.micOn {
		s.mu.Unlock()
		return
	}
	s.micOn = true
	s.mu.Unlock()
	mic := s.opt.Mic
	if mic == nil {
		mic = &SilentMic{}
	}
	if err := mic.Start(s.onMicFrame); err != nil {
		s.logf("microphone unavailable (%v): sending silence", err)
		_ = (&SilentMic{}).Start(s.onMicFrame)
	}
}

func (s *Session) stopAudio() {
	s.mu.Lock()
	if s.tap.feed.Load() != nil {
		s.tap.owns = true
		s.mu.Unlock()
		return
	}
	on := s.micOn
	s.micOn = false
	s.mu.Unlock()
	if on && s.opt.Mic != nil {
		s.opt.Mic.Stop()
	}
}

func (s *Session) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	s.opt.Logf("%s", line)
}

func (s *Session) onMicFrame(frame []int16) {
	s.micWatch.frames.Add(1)
	s.mic.Push(frame)
}

func (s *Session) Close() {
	s.stopRecording()
	s.Leave()
	s.mic.Close()
	s.cancel()
	s.dm.Close()
	s.rt.Close()
}

// State is a snapshot of what the screen draws from the session. It is rebuilt only when something in it changed, so
// the same pointer comes back from frame to frame, and it must not be modified.
type State struct {
	Me       hclient.User
	Channels []hclient.Channel
	Groups   []hclient.Group
	// ServerName is what the server calls itself.
	ServerName string
	Rosters    map[int][]hclient.Member
	Joined     int
	MyMid      int
	Muted      bool
	Deafened   bool
	Sharing    bool
	Camera     bool
	Members    []hclient.Account
	Presence   hclient.Presence
	// Roles are the server's roles, the highest first; Badges its badges; Server its own settings; Actor what Me may do.
	Roles  []hclient.Role
	Badges []hclient.Badge
	Server hclient.ServerInfo
	Actor  hclient.Actor
}

func (s *Session) State() *State {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snap != nil && s.snapRev == s.rev {
		return s.snap
	}
	st := &State{
		Me: s.me, Channels: slices.Clone(s.channels), Groups: s.groups, ServerName: s.name, Rosters: make(map[int][]hclient.Member, len(s.rosters)),
		Muted: s.muted, Deafened: s.deafened, Sharing: s.share != nil, Camera: s.cam != nil, Members: s.members, Presence: s.presence,
		Roles: s.roles, Badges: s.badges, Server: s.server, Actor: hclient.ActorOf(s.me, s.roles),
	}
	for id, members := range s.rosters {
		st.Rosters[id] = slices.Clone(members)
	}
	if s.joined != nil {
		st.Joined, st.MyMid = s.joined.ChannelID, s.joined.Mid
	}
	s.snap, s.snapRev = st, s.rev
	s.people.SetAccounts(s.members)
	s.people.SetRoles(s.roles)
	return st
}

// Streams is every camera and share in the room, yours included, with what is known of those being watched. It changes
// with every picture, so it is read afresh; the slice is reused by the next call and only for the interface's thread.
func (s *Session) Streams() []Stream {
	st := s.State()
	list := s.viewers.streams(st.Rosters[st.Joined], st.MyMid)
	s.audio.mu.Lock()
	for i := range list {
		if g, ok := s.audio.vol[list[i].User]; ok && list[i].Kind == "s" {
			list[i].Gain = g
		}
	}
	s.audio.mu.Unlock()
	for i := range list {
		if list[i].Own && list[i].Kind == "s" {
			list[i].NoAudio = !s.audio.on.Load()
		}
	}
	return list
}

// PeerInfo is what is known of one voice in the room.
type PeerInfo struct {
	Mid     int
	Nick    string
	Level   float64
	Packets int64
	Live    bool
}

// Peers lists the voices being heard, for diagnostics.
func (s *Session) Peers() []PeerInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []PeerInfo
	for mid, p := range s.peers {
		info := PeerInfo{Mid: mid, Nick: p.nick, Level: p.src.Level()}
		p.mu.Lock()
		if p.sub != nil {
			info.Packets, info.Live = p.sub.Packets(), p.sub.Silent() < 3*time.Second
		}
		p.mu.Unlock()
		out = append(out, info)
	}
	return out
}

// PeerLevel is how loud that member of the room is right now, from 0 to 1.
func (s *Session) PeerLevel(mid int) float64 {
	s.mu.Lock()
	p := s.peers[mid]
	s.mu.Unlock()
	if p == nil {
		return 0
	}
	return p.src.Level()
}

func (s *Session) ShareFrames() int64  { return s.sentFrames("s") }
func (s *Session) CameraFrames() int64 { return s.sentFrames("c") }

func (s *Session) sentFrames(kind string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := *s.slot(kind); st != nil {
		return st.frames
	}
	return 0
}

func (s *Session) eventLoop() {
	for msg := range s.rt.Events {
		s.musicEvent(msg)
		switch msg.Type {
		case "channels":
			var m struct {
				Channels []hclient.Channel `json:"channels"`
				Groups   []hclient.Group   `json:"groups"`
			}
			if msg.Decode(&m) == nil {
				s.mu.Lock()
				s.channels, s.groups = m.Channels, m.Groups
				s.rev++
				s.mu.Unlock()
				s.changed()
			}
		case "presence:self":
			s.selfStatusEvent(msg)
		case "accounts", "user:updated":
			s.accountsEvent(msg)
		case "presence":
			var p hclient.Presence
			if msg.Decode(&p) == nil {
				s.mu.Lock()
				s.presence = p
				s.rev++
				s.mu.Unlock()
				s.changed()
			}
		case "voice:roster":
			var m struct {
				ChannelID int              `json:"channelId"`
				Roster    []hclient.Member `json:"roster"`
			}
			if msg.Decode(&m) != nil {
				continue
			}
			s.mu.Lock()
			before := s.rosters[m.ChannelID]
			s.rosters[m.ChannelID] = m.Roster
			s.rev++
			mine := s.joined != nil && s.joined.ChannelID == m.ChannelID
			myMid := 0
			if mine {
				myMid = s.joined.Mid
			}
			s.mu.Unlock()
			if mine {
				s.rosterCues(before, m.Roster)
				s.forceMuteNote(before, m.Roster, myMid)
				s.reconcile()
			}
			s.changed()
		case hclient.EventDown, hclient.EventUp, hclient.EventRejected, hclient.EventClosed, "kicked":
			s.connectionEvent(msg)
		case "roles", "badges", "server", "server:info":
			s.adminEvent(msg)
			s.publish(Change(msg.Type))
		case "soundpad", "soundpad:play", "soundpad:stop":
			s.soundEvent(msg)
		case "voice:moved":
			var m struct {
				ChannelID *int   `json:"channelId"`
				By        string `json:"by"`
			}
			if msg.Decode(&m) != nil {
				continue
			}
			s.movedEvent(m.ChannelID, m.By)
		default:
			if !s.dm.Handle(msg) {
				s.chat.Handle(msg)
			}
		}
	}
	s.ended()
}

func (s *Session) joinWith(channelID int, password string) error {
	s.leaveLocal()
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
	defer cancel()
	j, err := s.rt.Join(ctx, channelID, password)
	if err != nil {
		s.stopAudio()
		s.changed()
		return err
	}
	jctx, jcancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	s.joined, s.joinCtx = &j, jcancel
	s.rosters[channelID] = j.Roster
	s.rev++
	muted, deaf := s.muted, s.deafened
	s.mu.Unlock()
	s.logf("joined channel %d as member %d (%d in the room)", channelID, j.Mid, len(j.Roster))
	s.connectCue()
	s.preloadJoinSounds()
	s.musicJoined(jctx, j)
	if muted || deaf {
		_ = s.rt.Mute(ctx, channelID, muted || deaf, deaf)
	}

	s.startAudio()
	go s.runMic(jctx, channelID)
	go s.refreshTokens(jctx, channelID, time.Duration(j.ExpiresInMs)*time.Millisecond)
	s.reconcile()
	s.changed()
	return nil
}

func (s *Session) Leave() {
	s.mu.Lock()
	j := s.joined
	s.mu.Unlock()
	s.leaveLocal()
	s.stopAudio()
	s.changed()
	if j != nil {
		s.leftCue()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.rt.Leave(ctx, j.ChannelID)
	}
}

func (s *Session) leaveLocal() {
	s.musicLeft()
	s.StopShare()
	s.StopCamera()
	s.stopViewers()
	s.mu.Lock()
	cancel := s.joinCtx
	s.joined, s.joinCtx = nil, nil
	s.rev++
	peers := s.peers
	s.peers = map[int]*peer{}
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	for _, p := range peers {
		p.cancel()
		s.mixer.Remove(p.src)
	}
}

func (s *Session) tokens() (hclient.Tokens, int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.joined == nil {
		return hclient.Tokens{}, 0, false
	}
	return s.joined.Tokens, s.joined.ChannelID, true
}

func (s *Session) refreshTokens(ctx context.Context, channelID int, lifetime time.Duration) {
	every := max(lifetime/2, 30*time.Second)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		t, err := s.rt.Refresh(ctx, channelID)
		if err != nil {
			s.logf("could not renew the media tokens: %v", err)
			continue
		}
		s.mu.Lock()
		if s.joined != nil && s.joined.ChannelID == channelID {
			s.joined.Tokens = t
		}
		s.mu.Unlock()
	}
}

func (s *Session) runMic(ctx context.Context, channelID int) {
	go s.pingLoop(ctx)
	go s.watchMic(ctx)
	backoff := time.Second
	for ctx.Err() == nil {
		t, _, ok := s.tokens()
		if !ok {
			return
		}
		pub, err := s.engine.PublishVoice(ctx, t.Publish.Voice)
		if err != nil {
			s.logf("microphone path: %v (retrying)", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 10*time.Second)
			continue
		}
		backoff = time.Second
		pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
		if err := s.rt.Publishing(pctx, channelID, "v", true); err != nil {
			s.logf("could not announce the microphone: %v", err)
		}
		pcancel()
		s.logf("microphone path is up")

		s.ping.pub.Store(pub)
		s.pumpMic(ctx, pub)
		s.ping.pub.Store(nil)
		pub.Close()
		if ctx.Err() == nil {
			s.logf("microphone path dropped: rebuilding")
		}
	}
}

func (s *Session) pumpMic(ctx context.Context, pub *media.VoicePublisher) {
	silence := make([]int16, media.FrameSamples)
	for {
		select {
		case <-ctx.Done():
			return
		case <-pub.Failed:
			return
		case frame := <-s.micFrames:
			s.mu.Lock()
			quiet := s.muted || s.deafened
			s.mu.Unlock()
			send := frame
			if quiet || !s.PTTGate() {
				send = silence
			}
			err := pub.WriteFrame(send)
			s.recycleMic(frame)
			if err != nil {
				return
			}
		}
	}
}

// SetOutputVolume is the master volume of everything played, 1 being as it is.
func (s *Session) SetOutputVolume(v float64) { s.mixer.SetVolume(v) }

func (s *Session) SetMuted(m bool) {
	s.mu.Lock()
	wasMuted, wasDeaf := s.muted, s.deafened
	s.muted = m
	if !m {
		s.deafened = false
	}
	s.rev++
	deaf := s.deafened
	j := s.joined
	s.mu.Unlock()
	s.mixer.SetDeafened(deaf)
	s.muteCue(wasMuted, wasDeaf)
	go s.musicSync()
	s.announceMute(j)
	s.changed()
}

func (s *Session) SetDeafened(d bool) {
	s.mu.Lock()
	wasMuted, wasDeaf := s.muted, s.deafened
	s.deafened = d
	s.rev++
	j := s.joined
	s.mu.Unlock()
	s.mixer.SetDeafened(d)
	s.muteCue(wasMuted, wasDeaf)
	go s.musicSync()
	s.announceMute(j)
	s.changed()
}

func (s *Session) announceMute(j *hclient.Joined) {
	if j == nil {
		return
	}
	s.mu.Lock()
	muted, deaf := s.muted || s.deafened, s.deafened
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	if err := s.rt.Mute(ctx, j.ChannelID, muted, deaf); err != nil {
		s.logf("could not tell the room: %v", err)
	}
}

func (s *Session) reconcile() {
	s.mu.Lock()
	if s.joined == nil {
		s.mu.Unlock()
		return
	}
	j := s.joined
	roster := append([]hclient.Member(nil), s.rosters[j.ChannelID]...)
	want := map[int]hclient.Member{}
	for _, m := range roster {
		if m.Mid != j.Mid && m.Publishes("v") {
			want[m.Mid] = m
		}
	}
	var gone []*peer
	for mid, p := range s.peers {
		if _, ok := want[mid]; !ok {
			gone = append(gone, p)
			delete(s.peers, mid)
		}
	}
	var fresh []*peer
	mids := make([]int, 0, len(want))
	for mid := range want {
		mids = append(mids, mid)
	}
	sort.Ints(mids)
	for _, mid := range mids {
		if _, ok := s.peers[mid]; ok {
			continue
		}
		pctx, cancel := context.WithCancel(s.ctx)
		p := &peer{mid: mid, user: want[mid].UserID, nick: want[mid].Nickname, src: s.mixer.NewSource(want[mid].Nickname), cancel: cancel}
		p.src.SetGain(s.peerGain(p.user))
		s.peers[mid] = p
		fresh = append(fresh, p)
		go s.runPeer(pctx, p, len(fresh)-1)
	}
	s.mu.Unlock()
	for _, p := range gone {
		p.cancel()
		s.mixer.Remove(p.src)
		s.logf("%s left the voice", p.nick)
	}
	s.syncViewers(roster)
}

func (s *Session) runPeer(ctx context.Context, p *peer, index int) {
	// Subscriptions open 75 ms apart: each one is an ICE gather and a DTLS handshake.
	select {
	case <-ctx.Done():
		return
	case <-time.After(time.Duration(index) * 75 * time.Millisecond):
	}
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		t, channelID, ok := s.tokens()
		if !ok {
			return
		}
		sub, err := s.engine.SubscribeVoice(ctx, t.PeerURL(channelID, p.mid, "v"), p.src)
		if err != nil {
			if !errors.Is(err, media.ErrNotLive) {
				s.logf("listening to %s: %v", p.nick, err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 8*time.Second)
			continue
		}
		backoff = 500 * time.Millisecond
		p.mu.Lock()
		p.sub = sub
		p.mu.Unlock()
		s.logf("listening to %s", p.nick)

	watch:
		for {
			select {
			case <-ctx.Done():
				break watch
			case <-sub.Failed:
				break watch
			case <-time.After(time.Second):
				if sub.Silent() > 8*time.Second {
					s.logf("%s went silent on the wire: reconnecting", p.nick)
					break watch
				}
			}
		}
		sub.Close()
		p.mu.Lock()
		p.sub = nil
		p.mu.Unlock()
	}
}

func (s *Session) StartShare(opts video.CaptureOptions) error { return s.startVideo("s", opts) }
func (s *Session) StopShare()                                 { s.stopVideo("s") }
func (s *Session) StopCamera()                                { s.stopVideo("c") }

// slot is where the published video of this kind is kept; call with s.mu held.
func (s *Session) slot(kind string) **shareState {
	if kind == "c" {
		return &s.cam
	}
	return &s.share
}

func videoName(kind string) string {
	if kind == "c" {
		return "camera"
	}
	return "screen"
}

// firstPicture is how long a camera or screen may take to deliver, which includes the time somebody takes to answer a permission prompt.
const firstPicture = 30 * time.Second

func publishURL(t hclient.Tokens, kind string) string {
	if kind == "c" {
		return t.Publish.Cam
	}
	return t.Publish.Screen
}

func (s *Session) startVideo(kind string, opts video.CaptureOptions) error {
	t, channelID, ok := s.tokens()
	if !ok {
		return ErrNotInVoice
	}
	s.mu.Lock()
	if s.starting[kind] {
		s.mu.Unlock()
		return nil
	}
	s.starting[kind] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.starting, kind)
		s.mu.Unlock()
		s.changed()
	}()
	s.stopVideo(kind)
	name := videoName(kind)
	ctx, cancel := context.WithCancel(s.ctx)
	capture, first, err := s.openCapture(name, opts)
	if err != nil {
		cancel()
		return fmt.Errorf("the %s could not be opened: %w", name, err)
	}
	pub, err := s.engine.PublishVideoAudio(ctx, publishURL(t, kind), video.ProfileLevelID(first), kind == "s" && s.wantsShareSound())
	if err != nil {
		capture.Close()
		cancel()
		return err
	}
	st := &shareState{cancel: cancel, cap: capture, profile: video.ProfileLevelID(first), done: make(chan struct{}), restart: make(chan struct{}, 1)}
	s.mu.Lock()
	if s.joined == nil || s.joined.ChannelID != channelID {
		s.mu.Unlock()
		capture.Close()
		pub.Close()
		cancel()
		return errors.New("you left the voice channel")
	}
	*s.slot(kind) = st
	s.rev++
	s.mu.Unlock()
	s.videoCue(kind, true)

	pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
	_ = s.rt.Publishing(pctx, channelID, kind, true)
	pcancel()
	s.logf("sending the %s (%s, profile-level-id %s)", name, capture.Mode(), pub.Profile())

	go s.sendVideo(ctx, kind, st, pub, first)
	if kind == "s" {
		go s.startShareAudio()
		go s.governShare(ctx, st)
	}
	return nil
}

// openCapture starts the capture and waits for its first picture. A codec the person chose that cannot start is given up
// once, in the log, for the automatic choice.
func (s *Session) openCapture(name string, opts video.CaptureOptions) (*video.Capture, []byte, error) {
	for {
		capture, err := video.StartCapture(opts)
		if err == nil {
			var first []byte
			if first, err = capture.FirstAU(firstPicture); err == nil {
				return capture, first, nil
			}
		}
		if opts.Encoder == "" || errors.Is(err, video.ErrNoPicture) {
			return nil, nil, err
		}
		s.logf("the %s encoder %q did not start (%v): using the automatic choice", name, opts.Encoder, err)
		opts.Encoder = ""
	}
}

// sendVideo keeps the capture running for as long as it lasts and carries it over to a new peer connection whenever the relay drops this one.
func (s *Session) sendVideo(ctx context.Context, kind string, st *shareState, pub *media.VideoPublisher, first []byte) {
	defer close(st.done)
	au := first
	for {
		var err error
		au, err = s.pumpVideo(kind, st, pub, au)
		pub.Close()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			s.logf("%s capture ended: %v", videoName(kind), err)
			s.endVideo(kind, st)
			if kind == "c" {
				s.cameraNote(NoteStopped)
			}
			return
		}
		s.logf("the %s path dropped: rebuilding", videoName(kind))
		if pub = s.republishVideo(ctx, kind, st.profile); pub == nil {
			return
		}
	}
}

// republishVideo retries until a new peer connection is up; nil means the capture was stopped or the room left.
func (s *Session) republishVideo(ctx context.Context, kind, profile string) *media.VideoPublisher {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
		t, channelID, ok := s.tokens()
		if !ok {
			return nil
		}
		pub, err := s.engine.PublishVideoAudio(ctx, publishURL(t, kind), profile, kind == "s" && s.wantsShareSound())
		if err != nil {
			if ctx.Err() == nil {
				s.logf("%s path: %v (retrying)", videoName(kind), err)
			}
			continue
		}
		pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
		_ = s.rt.Publishing(pctx, channelID, kind, true)
		pcancel()
		s.logf("%s path is up", videoName(kind))
		return pub
	}
}

// pumpVideo sends pictures until the peer connection fails (nil error, with the picture that was not sent) or the capture ends.
func (s *Session) pumpVideo(kind string, st *shareState, pub *media.VideoPublisher, au []byte) ([]byte, error) {
	for {
		if err := pub.WriteAU(au); err != nil {
			return au, nil
		}
		if kind == "s" {
			s.sharing.pub.Store(pub)
			s.sharing.sent(au)
		}
		s.mu.Lock()
		st.frames++
		s.mu.Unlock()
		s.previewAU(kind, au)
		if kind == "c" {
			s.camera.feed(au)
		}
		next, err := s.nextAU(kind, st)
		if err != nil {
			return au, err
		}
		au = next
		select {
		case <-pub.Failed:
			return au, nil
		case <-st.restart:
			return au, nil
		default:
		}
	}
}

func (s *Session) stopVideo(kind string) { s.endVideo(kind, nil) }

// endVideo stops what is being sent of this kind; with only set it does nothing unless that is the one running, and does not wait for itself.
func (s *Session) endVideo(kind string, only *shareState) {
	s.mu.Lock()
	slot := s.slot(kind)
	st := *slot
	if st == nil || only != nil && st != only {
		s.mu.Unlock()
		return
	}
	*slot = nil
	s.rev++
	j := s.joined
	s.mu.Unlock()
	st.cancel()
	s.closeCapture(kind, st)
	if kind == "s" {
		s.stopShareAudio()
	}
	if only == nil {
		<-st.done
	}
	if j != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.rt.Publishing(ctx, j.ChannelID, kind, false)
	}
	s.logf("stopped sending the %s", videoName(kind))
	s.videoCue(kind, false)
	s.changed()
}
