package app

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/music"
)

const (
	musicCheck      = 2 * time.Second
	musicProbeEvery = 15 * time.Second
	musicPrefetch   = 2
	maxMusicGain    = 3.5
	musicAskTimeout = 15 * time.Second
	musicPermission = "music.control"
)

// MusicError is a reply of the server that says no, by its code: forbidden, queue_full, no_such_track and the like.
type MusicError struct{ Code string }

func (e *MusicError) Error() string { return e.Code }

// musicPart is Music Buddy's side of a session: the state the server told, the player and the files it plays.
type musicPart struct {
	mirror *music.Mirror
	player *music.Player
	cache  *music.Cache

	mu        sync.Mutex
	bad       map[string]bool
	percent   atomic.Int32
	muted     atomic.Bool
	resyncing atomic.Bool
	notice    atomic.Pointer[func(title string)]
}

func (s *Session) startMusic() {
	m := &s.music
	m.mirror = music.NewMirror(nil)
	m.player = music.NewPlayer(s.mixer)
	m.cache = &music.Cache{Dir: music.DefaultDir(), Fetch: s.client.DownloadTo}
	m.bad = map[string]bool{}
	m.percent.Store(defaultPercent)
}

// SetMusicNotice sets what is told when the server could not get a track, with the track's title.
func (s *Session) SetMusicNotice(fn func(title string)) { s.music.notice.Store(&fn) }

// SetMusicVolume is how loud the music plays for this person, in percent of the track, and whether it is muted.
func (s *Session) SetMusicVolume(percent int, muted bool) {
	m := &s.music
	changed := m.percent.Swap(int32(percent)) != int32(percent)
	if m.muted.Swap(muted) != muted || changed {
		go s.musicSync()
	}
}

// Music is the music of the voice channel, or nil when there is none; it must not be changed.
func (s *Session) Music() *music.State {
	if s.State().Joined == 0 {
		return nil
	}
	return s.music.mirror.State()
}

// MusicPosition is where in the current track the music ought to be now.
func (s *Session) MusicPosition() time.Duration { return s.music.mirror.Position() }

// MusicLatency is how long the server's pushes take to get here, as measured.
func (s *Session) MusicLatency() time.Duration { return s.music.mirror.Latency() }

// MusicHeard is where in the track the sound coming out is; ok is false while nothing sounds.
func (s *Session) MusicHeard() (time.Duration, bool) { return s.music.player.Heard() }

// MusicCan is whether this person may play and control music here: in a call, on a server where the owner has it on, with the permission.
func (s *Session) MusicCan() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.joined != nil && s.server.MusicEnabled && hclient.Hello{User: s.me, Roles: s.roles}.Can(musicPermission)
}

// MusicResolve looks up a link or some words for tracks to add.
func (s *Session) MusicResolve(ctx context.Context, input string) (hclient.MusicFound, error) {
	return s.client.MusicResolve(ctx, input)
}

// MusicAdd puts tracks in the channel's queue, right after the current one when next is set.
func (s *Session) MusicAdd(items []hclient.MusicItem, next bool) error {
	return s.musicAsk("music:add", map[string]any{"items": items, "next": next})
}

// MusicControl is one of the controls: pause, resume, next, prev, seek (positionMs), shuffle (on), reshuffle, next-up (id), repeat (mode), play (id), remove (id), move (id, index), clear.
func (s *Session) MusicControl(action string, args map[string]any) error {
	fields := map[string]any{"action": action}
	for k, v := range args {
		fields[k] = v
	}
	return s.musicAsk("music:control", fields)
}

func (s *Session) musicAsk(typ string, fields map[string]any) error {
	_, channelID, ok := s.tokens()
	if !ok {
		return &MusicError{"not_in_channel"}
	}
	fields["channelId"] = channelID
	ctx, cancel := context.WithTimeout(s.ctx, musicAskTimeout)
	defer cancel()
	msg, err := s.rt.Request(ctx, typ, fields)
	if err != nil && msg.Type == "voice:error" {
		var e struct {
			Error string `json:"error"`
		}
		if msg.Decode(&e) == nil && e.Error != "" {
			return &MusicError{e.Error}
		}
	}
	return err
}

// musicEvent follows what the server says of the music, whatever else is done with the same message.
func (s *Session) musicEvent(msg hclient.Message) {
	switch msg.Type {
	case "music:state":
		var m struct {
			ChannelID int `json:"channelId"`
			music.Snapshot
		}
		if msg.Decode(&m) == nil && s.musicHere(m.ChannelID) {
			s.music.mirror.Apply(&m.Snapshot)
			s.musicChanged()
		}
	case "music:tick":
		var b struct {
			ChannelID int `json:"channelId"`
			music.Beat
		}
		if msg.Decode(&b) != nil || !s.musicHere(b.ChannelID) {
			return
		}
		if s.music.mirror.Tick(b.Beat) {
			s.musicChanged()
		} else {
			go s.musicResync()
		}
	case "music:error":
		var e struct {
			ChannelID int    `json:"channelId"`
			Title     string `json:"title"`
		}
		if msg.Decode(&e) == nil && s.musicHere(e.ChannelID) {
			if notice := s.music.notice.Load(); notice != nil {
				(*notice)(e.Title)
			}
		}
	case "server:info", "server":
		var m struct {
			Info   *hclient.ServerInfo `json:"info"`
			Server *hclient.ServerInfo `json:"server"`
		}
		if msg.Decode(&m) != nil {
			return
		}
		info := m.Info
		if info == nil {
			info = m.Server
		}
		if info != nil && !info.MusicEnabled {
			s.music.mirror.Apply(nil)
			s.musicChanged()
		}
	}
}

func (s *Session) musicHere(channelID int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.joined != nil && s.joined.ChannelID == channelID
}

func (s *Session) musicChanged() {
	s.musicSync()
	s.changed()
}

// musicJoined starts following the music of the channel that was joined: what is playing now, and the clock.
func (s *Session) musicJoined(ctx context.Context, j hclient.Joined) {
	var snap *music.Snapshot
	if len(j.Music) > 0 {
		_ = json.Unmarshal(j.Music, &snap)
	}
	s.music.mirror.Apply(snap)
	s.musicSync()
	go s.musicWatch(ctx, j.ChannelID)
}

// musicLeft ends the music with the call.
func (s *Session) musicLeft() {
	s.music.mirror.Apply(nil)
	s.music.player.Stop()
}

// musicWatch measures the server's clock, three times in quick succession once there is music and then now and then, and checks the sound against where it ought to be.
func (s *Session) musicWatch(ctx context.Context, channelID int) {
	check := time.NewTicker(musicCheck)
	defer check.Stop()
	nextProbe := time.Now()
	probes := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-check.C:
		}
		if s.music.mirror.State() == nil {
			probes = 0
			continue
		}
		if !time.Now().Before(nextProbe) {
			pctx, cancel := context.WithTimeout(ctx, musicAskTimeout)
			if _, rtt, err := s.rt.MusicClock(pctx, channelID); err == nil {
				s.music.mirror.Calibrate(rtt)
			}
			cancel()
			if probes++; probes < 3 {
				nextProbe = time.Now()
			} else {
				nextProbe = time.Now().Add(musicProbeEvery)
			}
		}
		s.musicSync()
	}
}

func (s *Session) musicResync() {
	m := &s.music
	if !m.resyncing.CompareAndSwap(false, true) {
		return
	}
	defer m.resyncing.Store(false)
	_, channelID, ok := s.tokens()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, musicAskTimeout)
	defer cancel()
	msg, err := s.rt.Request(ctx, "music:sync", map[string]any{"channelId": channelID})
	if err != nil {
		return
	}
	var r struct {
		Music *music.Snapshot `json:"music"`
	}
	if msg.Decode(&r) == nil {
		m.mirror.Apply(r.Music)
		s.musicChanged()
	}
}

// musicGain is how loud the music is made now: its own volume, silent when muted or when the person is deafened.
func (s *Session) musicGain() float64 {
	s.mu.Lock()
	deaf := s.deafened
	s.mu.Unlock()
	m := &s.music
	if deaf || m.muted.Load() {
		return 0
	}
	return min(max(float64(m.percent.Load())/100, 0), maxMusicGain)
}

// musicSync makes the sound what the state says: the current track, from where it ought to be, playing or paused.
func (s *Session) musicSync() {
	m := &s.music
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.mirror.State()
	track := st.Now()
	if track == nil || track.Hash == "" || (st.Status != music.Playing && st.Status != music.Paused) {
		_ = m.player.Update(music.Want{}, 0)
		s.musicPrefetchLocked(st)
		return
	}
	s.musicPrefetchLocked(st)
	path, ok := m.cache.Have(track.Hash)
	if !ok {
		_ = m.player.Update(music.Want{}, 0)
		go s.musicFetch(track.Hash)
		return
	}
	if m.bad[track.Hash] {
		return
	}
	want := music.Want{Key: track.ID + ":" + track.Hash, Path: path, Playing: st.Status == music.Playing, Gain: s.musicGain() * track.Level()}
	if err := m.player.Update(want, m.mirror.Position()); err != nil {
		m.bad[track.Hash] = true
		s.logf("could not play %q: %v", track.Title, err)
	}
}

// musicPrefetchLocked starts fetching the tracks that come after the current one, so that each is here when its turn comes.
func (s *Session) musicPrefetchLocked(st *music.State) {
	if st == nil {
		return
	}
	after := -1
	for i := range st.Queue {
		if st.Queue[i].ID == st.Current {
			after = i
		}
	}
	for i := after + 1; i < len(st.Queue) && i <= after+musicPrefetch; i++ {
		if hash := st.Queue[i].Hash; hash != "" {
			if _, ok := s.music.cache.Have(hash); !ok {
				go s.musicFetch(hash)
			}
		}
	}
}

func (s *Session) musicFetch(hash string) {
	m := &s.music
	if _, err := m.cache.Ensure(s.ctx, hash); err != nil {
		if s.ctx.Err() == nil {
			s.logf("could not fetch a track: %v", err)
		}
		return
	}
	if st := m.mirror.State(); st != nil {
		keep := make(map[string]bool, len(st.Queue))
		for _, t := range st.Queue {
			keep[t.Hash] = true
		}
		m.cache.Trim(keep)
	}
	s.musicSync()
}
