// Package channels is the main screen once signed in: the channel list, the voice room, the members and who you are.
package channels

import (
	"harmony/v2/internal/screens/profilecard"
	"harmony/v2/internal/screens/serveradmin"
	"sync"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/audio"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/music"
	"harmony/v2/internal/screens/soundboard"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const (
	barHeight     = 60
	layoutPadding = 16
	layoutPadLeft = 8
	columnGap     = 16
	mainMinWidth  = 240
	narrowWidth   = 720
	speakingLevel = 0.01
	speakingPoll  = 100 * time.Millisecond
)

type Screen struct {
	Session    *app.Session
	Settings   *store.Settings
	Server     store.Server
	OnSignOut  func()
	OnSettings func()
	// OnServerDialog opens the Server dialog on a page and item.
	OnServerDialog func(serveradmin.Target)
	Devices        *audio.Devices
	ShareHooks     ShareHooks
	// ClipKeys lets the soundboard's clips have hotkeys; nil leaves them out.
	ClipKeys soundboard.Hotkeys

	membersSearch  widget.TextField
	channelScroll  widget.Scroll
	folded         map[int]bool
	rosterScroll   widget.Scroll
	memberScroll   widget.Scroll
	sound          soundboard.Board
	music          musicUI
	joinedAt       time.Time
	joinedID       int
	mu             sync.Mutex
	errText        string
	isNote         bool
	errSeq         int
	chat           chatState
	dm             dmState
	forum          forumState
	call           callStage
	audio          audioControls
	voice          voiceNotes
	watch          speakingWatch
	seen           model
	list           channelList
	bar            barButtons
	panel          voicePanel
	shareBar       shareBar
	shareMenuState shareMenu
	shareLabels    [2]string
	scope          string
	scopeUser      int
	strip          stripActions
	picker         statusPicker
	people         memberList
	profile        profilecard.Card
	admin          channelAdmin
	peer           peerMenu
	room           roomFlow
	tip            widget.Tooltip
	devices        deviceWatch
	pdrag          personDrag
	nav            navState
	resize         resizing
	drawer         drawerState
}

// ShareHooks lets the screen start and stop a screen share without knowing how capture is configured.
type ShareHooks struct {
	Start       func() error
	StartCamera func() error
	// Change opens the picker over a running share, to swap what it shows.
	Change func()
}

// model is what one frame draws, read once from the session.
type model struct {
	state *app.State
	// streams is the room's cameras and shares, read afresh by every frame while in a room.
	streams  []app.Stream
	channels []hclient.Channel
	joined   *hclient.Channel
	roster   []hclient.Member
	online   map[int]widget.Presence
	// music is the voice channel's music and musicCan whether this person may steer it.
	music     *music.State
	musicCan  bool
	musicLive bool
}

// read is the model for this frame; what comes from the session's snapshot is made again only when the snapshot is.
func (s *Screen) read() model {
	st := s.Session.State()
	if st != s.seen.state {
		s.seen = model{state: st, channels: st.Channels, online: make(map[int]widget.Presence, len(st.Presence.Online))}
		for _, id := range st.Presence.Online {
			s.seen.online[id] = widget.Online
			switch st.Presence.Statuses[id] {
			case "idle":
				s.seen.online[id] = widget.Idle
			case "dnd":
				s.seen.online[id] = widget.DoNotDisturb
			}
		}
		for i := range st.Channels {
			if st.Channels[i].ID == st.Joined {
				s.seen.joined = &st.Channels[i]
				s.seen.roster = st.Rosters[st.Joined]
			}
		}
	}
	m := s.seen
	if st.Joined != 0 {
		m.streams = s.Session.Streams()
		m.music, m.musicCan = s.Session.Music(), s.Session.MusicCan()
		m.musicLive = m.music.Live()
	}
	if st.Joined != s.joinedID {
		s.joinedID, s.joinedAt = st.Joined, time.Now()
	}
	return m
}

func (s *Screen) Draw(c *widget.Context, bounds geom.Rect) {
	m := s.read()
	s.navNote()
	if s.dm.page {
		s.drawDMPage(c, bounds, m)
		return
	}
	l := s.layout(bounds)
	s.watch.follow(s.Session, m.joined != nil)
	s.roomFrame(c)

	if l.narrow {
		s.drawNarrow(c, l, m)
		s.dm.member.Show(c)
		s.admin.menu.Show(c)
		s.showPeerMenus(c)
		s.drawProfileCard(c)
		return
	}
	s.drawBar(c, l, m)
	s.drawColumnLines(c, l)
	s.drawChannelList(c, l, m)
	s.drawMain(c, l, m)
	if l.members.W > 0 {
		s.drawMembers(c, l, m)
	}
	s.drawServerHead(c, l)
	s.drawVoicePanel(c, l, m)
	s.drawSelfStrip(c, l, m)
	s.drawColumnHandles(c, l)
	s.dm.member.Show(c)
	s.admin.menu.Show(c)
	s.showPeerMenus(c)
	s.drawProfileCard(c)
}
