package channels

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/music"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	musicStripGap  = 8
	musicTick      = 500 * time.Millisecond
	musicResolveT  = 90 * time.Second
	musicMaxVolume = 350
)

var musicRepeatNext = map[string]string{"off": "all", "all": "one", "one": "off"}

var musicKnownMusicErrors = map[string]bool{
	"music_off": true, "not_in_channel": true, "forbidden": true, "slow_down": true, "queue_full": true,
	"nothing_to_add": true, "no_such_track": true, "bad_mode": true, "nothing_to_mix": true,
}

// musicUI is Music Buddy on the voice panel: its button, the strip of what is playing, and the panel behind them.
type musicUI struct {
	ready   bool
	sess    *app.Session
	strings *i18n.Bundle
	view    *Screen

	pop     widget.Popover
	opener  geom.Rect
	st      *music.State
	may     bool
	stripAt geom.Rect

	strip musicTransport
	deck  musicTransport
	mute  widget.TinyButton
	vol   widget.VolumeRow
	title widget.FitLine
	by    widget.FitLine

	nowTitle  widget.FitLine
	nowArtist widget.FitLine

	body  func(content geom.Rect)
	frame popFrame

	close   widget.PlateButton
	input   widget.TextField
	search  widget.Button
	seek    widget.Slider
	seeking bool
	clear   widget.Button

	mu         sync.Mutex
	note       string
	busy       bool
	pending    *hclient.MusicFound
	clearInput bool
	found      hclient.MusicFound
	results    musicResultList
	queue      musicQueueList
	resultS    widget.Scroll
	queueS     widget.Scroll
}

func (u *musicUI) init(s *Screen) {
	u.ready, u.sess, u.view = true, s.Session, s
	u.pop.Roomy = true
	s.Session.SetMusicNotice(func(title string) {
		s.fail(errors.New(u.strings.T("music.track_failed", "title", title)))
	})
	u.strip.init(u)
	u.deck.init(u)
	u.mute = widget.TinyButton{OnClick: u.toggleMute}
	u.vol = widget.VolumeRow{Strip: true, Max: musicMaxVolume, OnChange: u.setVolume, OnSettle: func(int) { s.Settings.Save() }}
	u.title = widget.FitLine{Style: musicBoldStyle(musicStripTitleSize), LineHeight: musicStripTitleLine}
	u.by = widget.FitLine{Style: musicSmallStyle(musicStripArtistSize), Tone: widget.ToneMuted, LineHeight: musicStripArtistLine}
	u.nowTitle = widget.FitLine{Style: musicBoldStyle(14), LineHeight: 21}
	u.nowArtist = widget.FitLine{Style: musicSmallStyle(14), Tone: widget.ToneMuted, LineHeight: 21}
	u.close = widget.PlateButton{Icon: "x", Variant: widget.Ghost, OnClick: u.closePop}
	u.input = widget.TextField{OnEnter: u.find}
	u.search = widget.Button{Variant: widget.Primary, OnClick: u.find}
	u.clear = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() { u.ask("clear", nil) }}
	u.seek = widget.Slider{Max: 1000, Step: 1, OnChange: u.seeking1, OnCommit: u.seeked}
	u.results.owner, u.queue.owner = u, u
	u.resultS.Bar, u.queueS.Bar = true, true
	u.resultS.Child, u.queueS.Child = &u.results, &u.queue
}

func (u *musicUI) toggle() {
	if u.pop.IsOpen() {
		u.pop.Close()
		return
	}
	u.mu.Lock()
	u.note = ""
	u.mu.Unlock()
	if u.may {
		u.input.RequestFocus()
	}
	u.pop.Open()
}

func (u *musicUI) closePop() { u.pop.Close() }

// begin reads this frame's music and brings the widgets up to date with it and with the settings.
func (u *musicUI) begin(s *Screen, c *widget.Context, m model) {
	u.strings = c.Strings
	if !u.ready {
		u.init(s)
	}
	u.st, u.may = m.music, m.musicCan
	u.mu.Lock()
	if u.pending != nil {
		u.found, u.pending = *u.pending, nil
		u.results.rebuild(u)
	}
	if u.clearInput {
		u.input.Value, u.clearInput = "", false
	}
	u.mu.Unlock()
	st := s.Settings
	u.sess.SetMusicVolume(st.MusicVolume, st.MusicMuted)
	u.vol.Value = st.MusicVolume
	u.mute.Icon = "speaker-high"
	if st.MusicMuted || st.MusicVolume == 0 {
		u.mute.Icon = "speaker-x"
	}
}

func (u *musicUI) setVolume(percent int) {
	s := u.view.Settings
	s.MusicVolume, s.MusicMuted = percent, false
	u.sess.SetMusicVolume(percent, false)
}

func (u *musicUI) toggleMute() {
	s := u.view.Settings
	s.MusicMuted = !s.MusicMuted
	s.Save()
	u.sess.SetMusicVolume(s.MusicVolume, s.MusicMuted)
}

func (u *musicUI) seeking1(int) { u.seeking = true }

func (u *musicUI) seeked(value int) {
	if track := u.st.Now(); track != nil && track.DurationMs > 0 {
		u.ask("seek", map[string]any{"positionMs": int64(value) * track.DurationMs / 1000})
	}
	u.seeking = false
}

// ask sends one of the controls; a refusal is shown in the panel.
func (u *musicUI) ask(action string, args map[string]any) {
	go func() { u.report(u.sess.MusicControl(action, args)) }()
}

func (u *musicUI) report(err error) {
	u.mu.Lock()
	u.note = u.reason(err)
	u.mu.Unlock()
	redraw.Request()
}

func (u *musicUI) reason(err error) string {
	if err == nil {
		return ""
	}
	strings := u.strings
	var denied *app.MusicError
	if errors.As(err, &denied) && musicKnownMusicErrors[denied.Code] {
		return strings.T("music.err_" + denied.Code)
	}
	var api *hclient.APIError
	if errors.As(err, &api) {
		if api.Message != "" {
			return api.Message
		}
		if musicKnownMusicErrors[api.Code] {
			return strings.T("music.err_" + api.Code)
		}
	}
	return strings.T("music.err_failed")
}

func (u *musicUI) find() {
	text := u.input.Value
	u.mu.Lock()
	if u.busy || len(text) == 0 {
		u.mu.Unlock()
		return
	}
	u.busy, u.note = true, ""
	u.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), musicResolveT)
		defer cancel()
		found, err := u.sess.MusicResolve(ctx, text)
		u.mu.Lock()
		u.busy = false
		if err != nil {
			u.note = u.reason(err)
		} else if len(found.Items) == 0 {
			u.note = u.strings.T("music.no_results")
		}
		u.pending = &found
		u.mu.Unlock()
		redraw.Request()
	}()
}

func (u *musicUI) add(items []hclient.MusicItem, next, all bool) {
	go func() {
		err := u.sess.MusicAdd(items, next)
		u.report(err)
		if err == nil && all {
			u.mu.Lock()
			u.pending, u.clearInput = &hclient.MusicFound{}, true
			u.mu.Unlock()
			redraw.Request()
		}
	}()
}

func (u *musicUI) pendingNote() (note string, busy bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.note, u.busy
}

// musicClockText is 3:07, or 1:02:03.
func musicClockText(ms int64) string {
	total := max(int64(0), ms/1000)
	h, m, sec := total/3600, total%3600/60, total%60
	two := func(n int64) string {
		if n < 10 {
			return "0" + strconv.FormatInt(n, 10)
		}
		return strconv.FormatInt(n, 10)
	}
	if h > 0 {
		return strconv.FormatInt(h, 10) + ":" + two(m) + ":" + two(sec)
	}
	return strconv.FormatInt(m, 10) + ":" + two(sec)
}

// drawMusic draws what Music Buddy adds to the voice panel: the strip under the buttons, and the panel when it is open.
func (s *Screen) drawMusic(c *widget.Context, m model, at, button geom.Rect) {
	u := &s.music
	u.begin(s, c, m)
	if m.musicLive {
		at.H = musicStripHeight(c, m.musicCan)
		u.drawStrip(c, s, at)
		if m.music.Status == music.Playing {
			redraw.After(musicTick)
		}
	}
	if !m.musicCan && !m.musicLive {
		u.pop.Close()
	}
	anchor := button
	if !m.musicCan {
		anchor = u.opener
	}
	u.showPop(c, s, anchor, button)
}
