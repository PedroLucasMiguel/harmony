// The sound of a screen share, both ways. Sending: what the computer plays is captured natively (package native), cut into
// 20 ms Opus frames and sent on the audio track of the share's own peer connection, which a rebuilt connection takes over.
// Receiving: a watched share's sound is decoded into a mixer source of its own, with a volume kept per person.
//
// Locks: audioPart.mu is a leaf.
package app

import (
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/shareaudio"
	"harmony/v2/internal/video/native"
)

// MaxStreamGain is the loudest a share is played, 350% as for a person.
const MaxStreamGain = 3.5

// noAudioAfter is how long a watched share may show a picture without any sound before it is called silent.
const noAudioAfter = 4 * time.Second

type audioPart struct {
	mu      sync.Mutex
	plan    shareaudio.Plan
	chosen  bool
	choose  func(source string) shareaudio.Plan
	capture native.AudioCapture
	note    string
	monitor *audio.Source
	vol     map[int]float64
	on      atomic.Bool
	hearing atomic.Bool
}

// SetShareAudioChooser tells the session how to decide a share's sound from its source (a native.SourceInfo.ID): the
// window around it knows what the person picked beside the source. Without one the share carries everything the computer
// plays but this program.
func (s *Session) SetShareAudioChooser(choose func(source string) shareaudio.Plan) {
	s.audio.mu.Lock()
	s.audio.choose = choose
	s.audio.mu.Unlock()
}

// planFor is the plan for the share's source now; a.mu is held.
func (s *Session) planFor() shareaudio.Plan {
	a := &s.audio
	if a.choose != nil {
		cfg, _ := s.ShareConfig()
		return a.choose(cfg.Source)
	}
	if !a.chosen {
		a.plan = shareaudio.Decide(shareaudio.Choice{Kind: shareaudio.Screen, Support: native.AudioSupportOf(), ExcludePID: os.Getpid()})
	}
	return a.plan
}

// shareSourceChanged follows a share whose source was swapped: another window is another application's sound.
func (s *Session) shareSourceChanged() {
	a := &s.audio
	a.mu.Lock()
	plan := s.planFor()
	same := plan.Via == a.plan.Via && plan.Capture == a.plan.Capture
	a.plan = plan
	a.mu.Unlock()
	if same {
		return
	}
	if pub := s.sharing.pub.Load(); plan.Via != shareaudio.None && (pub == nil || !pub.HasAudio()) {
		s.logf("the share has no sound track: stop it and share again to add the sound of that source")
		return
	}
	_ = s.startShareAudio()
}

// SetShareAudio chooses where the next share's sound comes from, or changes it while a share is running.
func (s *Session) SetShareAudio(plan shareaudio.Plan) error {
	a := &s.audio
	a.mu.Lock()
	a.plan, a.chosen = plan, true
	a.mu.Unlock()
	s.mu.Lock()
	live := s.share != nil
	s.mu.Unlock()
	if !live {
		return nil
	}
	if pub := s.sharing.pub.Load(); plan.Via != shareaudio.None && (pub == nil || !pub.HasAudio()) {
		return errors.New("this share was started without sound: stop it and share again to add some")
	}
	return s.startShareAudio()
}

// ShareAudioNote is what went wrong with the share's sound, empty when nothing did.
func (s *Session) ShareAudioNote() string {
	s.audio.mu.Lock()
	defer s.audio.mu.Unlock()
	return s.audio.note
}

// wantsShareSound resolves the plan (the default being everything the computer plays but this program) and says whether
// the share is to have a sound track.
func (s *Session) wantsShareSound() bool {
	a := &s.audio
	a.mu.Lock()
	defer a.mu.Unlock()
	a.plan = s.planFor()
	return a.plan.Via != shareaudio.None
}

// startShareAudio (re)starts the capture the plan asks for and sends it on the share's audio track.
func (s *Session) startShareAudio() error {
	a := &s.audio
	a.mu.Lock()
	plan := s.planFor()
	a.plan = plan
	old := a.capture
	a.capture = nil
	a.mu.Unlock()
	if old != nil {
		old.Close()
	}
	a.on.Store(false)
	if plan.Via == shareaudio.None {
		a.mu.Lock()
		a.note = ""
		a.mu.Unlock()
		s.changed()
		return nil
	}
	c, err := native.StartAudioCapture(plan.Capture, s.shareSound)
	s.mu.Lock()
	live := s.share != nil
	s.mu.Unlock()
	if err == nil && !live {
		c.Close()
		return nil
	}
	a.mu.Lock()
	if err != nil {
		a.note = err.Error()
	} else {
		a.note = ""
		a.capture = c
	}
	a.mu.Unlock()
	a.on.Store(err == nil)
	s.changed()
	if err != nil {
		s.logf("the share's sound could not be captured: %v", err)
	}
	return err
}

func (s *Session) stopShareAudio() {
	a := &s.audio
	a.mu.Lock()
	c := a.capture
	a.capture = nil
	mon := a.monitor
	a.monitor = nil
	a.mu.Unlock()
	a.on.Store(false)
	a.hearing.Store(false)
	if c != nil {
		c.Close()
	}
	if mon != nil {
		s.mixer.Remove(mon)
	}
}

// shareSound is called from the capture's goroutine with every block of sound.
func (s *Session) shareSound(pcm []int16) {
	if pub := s.sharing.pub.Load(); pub != nil {
		_ = pub.WriteAudio(pcm)
	}
	if !s.audio.hearing.Load() {
		return
	}
	s.audio.mu.Lock()
	mon := s.audio.monitor
	s.audio.mu.Unlock()
	if mon != nil {
		mon.Push(pcm)
	}
}

// CanMonitorShare is whether your own share's sound can be played to you without it coming back into the share.
func (s *Session) CanMonitorShare() bool {
	a := &s.audio
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.capture != nil && a.plan.SafeToMonitor
}

// SetShareMonitor plays your own share's sound to you, or stops.
func (s *Session) SetShareMonitor(on bool) error {
	a := &s.audio
	a.mu.Lock()
	if on && (a.capture == nil || !a.plan.SafeToMonitor) {
		a.mu.Unlock()
		return errors.New("there is nothing to monitor: this share has no sound that cannot come back into it")
	}
	if on && a.monitor == nil {
		a.monitor = s.mixer.NewSource("your stream")
	}
	if !on && a.monitor != nil {
		s.mixer.Remove(a.monitor)
		a.monitor = nil
	}
	a.mu.Unlock()
	a.hearing.Store(on)
	s.changed()
	return nil
}

// ShareMonitoring is whether you are hearing your own share.
func (s *Session) ShareMonitoring() bool { return s.audio.hearing.Load() }

// StreamGain is how loud somebody's share is played, 1 being as sent.
func (s *Session) StreamGain(user int) float64 {
	a := &s.audio
	a.mu.Lock()
	defer a.mu.Unlock()
	if g, ok := a.vol[user]; ok {
		return g
	}
	return 1
}

// LoadStreamPrefs replaces everybody's level with what was kept for this server.
func (s *Session) LoadStreamPrefs(saved map[int]float64) {
	a := &s.audio
	a.mu.Lock()
	a.vol = make(map[int]float64, len(saved))
	for user, g := range saved {
		a.vol[user] = min(max(g, 0), MaxStreamGain)
	}
	a.mu.Unlock()
	s.applyStreamGains()
}

// SetStreamGain plays the share of the person in this room slot at that many times its own volume, and returns the person
// so the level can be kept for them; 0 is mute.
func (s *Session) SetStreamGain(mid int, gain float64) (user int) {
	gain = min(max(gain, 0), MaxStreamGain)
	user = s.userOf(mid)
	a := &s.audio
	a.mu.Lock()
	if a.vol == nil {
		a.vol = map[int]float64{}
	}
	if gain == 1 {
		delete(a.vol, user)
	} else {
		a.vol[user] = gain
	}
	a.mu.Unlock()
	s.applyStreamGains()
	s.changed()
	return user
}

func (s *Session) userOf(mid int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.joined == nil {
		return 0
	}
	for _, m := range s.rosters[s.joined.ChannelID] {
		if m.Mid == mid {
			return m.UserID
		}
	}
	return 0
}

func (s *Session) applyStreamGains() {
	vs := &s.viewers
	vs.mu.Lock()
	list := make([]*viewer, 0, len(vs.list))
	for key, v := range vs.list {
		if key.kind == "s" {
			list = append(list, v)
		}
	}
	vs.mu.Unlock()
	for _, v := range list {
		v.applyGain()
	}
}
