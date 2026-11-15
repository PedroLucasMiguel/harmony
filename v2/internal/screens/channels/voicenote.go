package channels

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"harmony/v2/internal/chat"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/voicenote"
)

const (
	voiceRowH     = 49.6
	audioRowGap   = 7.8
	levelEvery    = 80 * time.Millisecond
	levelsKept    = 400
	speedInterval = 1.5
)

var speeds = [...]float64{1, 1.5, 2}

// voiceNotes is what the screen keeps for voice messages: the sounds it has prepared, the one player, and the recording in progress.
type voiceNotes struct {
	lib    *voicenote.Library
	player *voicenote.Player
	rec    *recording
}

type recording struct {
	rec     *voicenote.Recorder
	stop    func()
	channel int
	levels  []float32
	last    time.Time
}

func (s *Screen) voiceSetup() *voiceNotes {
	v := &s.voice
	if v.lib == nil {
		v.lib = voicenote.NewLibrary(redraw.Request)
		v.player = voicenote.NewPlayer(s.Session.Mixer(), redraw.Request, s.Session.OpenSpeakers, s.Session.CloseSpeakers)
	}
	return v
}

func clock(seconds float64) string {
	total := max(0, int(seconds))
	return fmt.Sprintf("%d:%02d", total/60, total%60)
}

func speedLabel(speed float64) string {
	return strconv.FormatFloat(speed, 'f', -1, 64) + "×"
}

// soundState is what a player row needs to show about one attachment.
type soundState struct {
	key      string
	info     voicenote.Info
	status   voicenote.Status
	progress float32
	playing  bool
	seconds  float64
}

func (s *Screen) soundOf(hash string) soundState {
	v := s.voiceSetup()
	st := soundState{key: hash}
	st.info, st.status = v.lib.Info(hash, s.chatFeed().Bytes(hash))
	st.playing = v.player.Playing(hash)
	st.seconds = st.info.Seconds()
	if at, ok := v.player.Position(hash); ok && st.info.Frames > 0 {
		st.progress = float32(at / float64(st.info.Frames))
		if st.playing || at > 0 {
			st.seconds = at / 48000
		}
	}
	return st
}

func (st soundState) elapsed() float64 {
	if st.playing || st.progress > 0 {
		return st.seconds
	}
	return 0
}

func (s *Screen) soundTime(st soundState) string {
	switch st.status {
	case voicenote.Loading:
		return "…"
	case voicenote.Failed:
		return "--:--"
	}
	return clock(st.seconds)
}

func (s *Screen) playSound(hash string) {
	v := s.voiceSetup()
	if v.player.Playing(hash) {
		v.player.Pause()
		return
	}
	go func() {
		track, err := v.lib.Track(hash, s.chatFeed().Bytes(hash))
		if err != nil {
			s.fail(err)
			return
		}
		v.player.Play(hash, track, -1)
	}()
}

func (s *Screen) seekSound(hash string, fraction float32, frames int) {
	v := s.voiceSetup()
	if frames == 0 {
		return
	}
	go func() {
		track, err := v.lib.Track(hash, s.chatFeed().Bytes(hash))
		if err != nil {
			s.fail(err)
			return
		}
		v.player.Load(hash, track)
		v.player.Seek(hash, int(float64(fraction)*float64(frames)))
	}()
}

func (s *Screen) nextSpeed() {
	v := s.voiceSetup()
	current := v.player.Speed()
	for i, sp := range speeds {
		if sp == current {
			v.player.SetSpeed(speeds[(i+1)%len(speeds)])
			return
		}
	}
	v.player.SetSpeed(1)
}

func (s *Screen) isVoiceNote(e *chat.Entry) bool {
	return voicenote.IsVoiceNote(e.Msg.AttachmentName, e.Msg.MediaType)
}

func (s *Screen) drawVoiceNote(c *widget.Context, e *chat.Entry, x, y, w float32) {
	st := s.soundOf(e.Msg.AttachmentHash)
	hash := e.Msg.AttachmentHash
	player := widget.VoicePlayer{
		Peaks: st.info.Peaks[:], Bars: voicenote.Bars, Progress: st.progress, Playing: st.playing,
		Time: s.soundTime(st), Speed: speedLabel(s.voice.player.Speed()),
		OnPlay:  func() { s.playSound(hash) },
		OnSeek:  func(f float32) { s.seekSound(hash, f, st.info.Frames) },
		OnSpeed: s.nextSpeed,
	}
	if st.status != voicenote.Ready {
		player.Peaks, player.Bars = nil, voicenote.Bars
	}
	size := player.Measure(c, w)
	player.Draw(c, geom.Rect{X: x, Y: y, W: size.W, H: size.H})
}

var audioNameStyle = paint.TextStyle{Size: attachBarSize, Weight: paint.Regular}

func (s *Screen) drawAudioFile(c *widget.Context, e *chat.Entry, l *entryLayout, x, y float32) {
	st := s.soundOf(e.Msg.AttachmentHash)
	hash := e.Msg.AttachmentHash
	bar := widget.AudioBar{
		Progress: st.progress, Playing: st.playing,
		Time:   clock(st.elapsed()) + " / " + clock(st.info.Seconds()),
		OnPlay: func() { s.playSound(hash) },
		OnSeek: func(f float32) { s.seekSound(hash, f, st.info.Frames) },
	}
	bar.Draw(c, geom.Rect{X: x, Y: y})
	s.drawFileName(c, e, l, x, y+bar.Measure(c, 0).H+audioRowGap)
}

// startRecording opens the microphone and begins a voice message for the open channel.
func (s *Screen) startRecording(c *widget.Context) {
	v := s.voiceSetup()
	if v.rec != nil {
		return
	}
	rec, err := voicenote.NewRecorder()
	if err != nil {
		s.fail(errors.New(c.T("voice.mic_failed")))
		return
	}
	stop, err := s.Session.RecordMic(rec.Feed)
	if err != nil {
		rec.Cancel()
		s.fail(errors.New(c.T("voice.mic_failed")))
		return
	}
	s.fail(nil)
	v.rec = &recording{rec: rec, stop: stop, channel: s.chat.channel}
	redraw.Request()
}

// cancelRecording throws away a recording in progress: the conversation it was for is gone.
func (s *Screen) cancelRecording() {
	r := s.voice.rec
	if r == nil {
		return
	}
	s.voice.rec = nil
	r.stop()
	r.rec.Cancel()
	redraw.Request()
}

func (s *Screen) sendRecording(c *widget.Context) {
	r := s.voice.rec
	if r == nil {
		return
	}
	s.voice.rec = nil
	r.stop()
	file, err := r.rec.Finish()
	redraw.Request()
	if errors.Is(err, voicenote.ErrTooShort) {
		s.fail(errors.New(c.T("voice.too_short")))
		return
	}
	if err != nil {
		s.fail(err)
		return
	}
	st := &s.chat
	replyTo := 0
	if st.reply != nil {
		replyTo = st.reply.ID
		st.reply = nil
	}
	st.sending = s.chatFeed().SendFile(r.channel, file.Name, voicenote.ContentType, file.Data, replyTo)
}

func (s *Screen) recording() bool { return s.voice.rec != nil }

// drawRecorder is the bar that replaces the message box's row while recording.
func (s *Screen) drawRecorder(c *widget.Context, row geom.Rect) {
	r := s.voice.rec
	if now := time.Now(); now.Sub(r.last) >= levelEvery {
		r.last = now
		if len(r.levels) == levelsKept {
			r.levels = append(r.levels[:0], r.levels[1:]...)
		}
		r.levels = append(r.levels, float32(r.rec.Level()))
	}
	if c.EscapeBase() {
		s.cancelRecording()
		return
	}
	if c.In.Enter {
		s.sendRecording(c)
		return
	}
	bar := widget.RecorderBar{
		Time: clock(r.rec.Elapsed().Seconds()), Levels: r.levels, Paused: r.rec.Paused(), Ready: true,
		OnDiscard: s.cancelRecording,
		OnPause:   func() { r.rec.SetPaused(!r.rec.Paused()) },
		OnSend:    func() { s.sendRecording(c) },
	}
	bar.Draw(c, row)
}

func (s *Screen) drawFileName(c *widget.Context, e *chat.Entry, l *entryLayout, x, y float32) {
	name := e.Msg.AttachmentName
	if name == "" {
		name = c.T("app.attachment")
	}
	c.Paint.Text(name, x, y, attachBarLine, audioNameStyle, c.Theme.Muted)
	c.Paint.Text(l.size, x+c.Paint.TextWidth(name, audioNameStyle)+6.4, y, attachBarLine, audioNameStyle, theme.WithAlpha(c.Theme.Muted, 0.8))
}
