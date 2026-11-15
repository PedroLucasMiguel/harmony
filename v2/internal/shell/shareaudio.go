package shell

import (
	"os"
	"strconv"
	"sync"

	"harmony/v2/internal/app"
	"harmony/v2/internal/screens/sharepicker"
	"harmony/v2/internal/shareaudio"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video/native"
)

// shareSound is what the picker's sound rows hold: which application is left out of a screen share, what a window share
// does when its application's sound cannot be had, and what the system can do about sound at all.
type shareSound struct {
	mu      sync.Mutex
	apps    []native.AudioApp
	loading bool
	loaded  bool
	exclude int
	chosen  bool
	pids    map[string]int
	support native.AudioSupport
	probed  bool

	drop widget.Dropdown
	seg  widget.Segmented
}

var sound shareSound

func (s *shareSound) supportNow() native.AudioSupport {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.probed {
		s.support, s.probed = native.AudioSupportOf(), true
	}
	return s.support
}

// reset forgets what the last picker listed, so the next one asks again.
func (s *shareSound) reset() {
	s.mu.Lock()
	s.loaded, s.chosen, s.pids = false, false, nil
	s.mu.Unlock()
}

func (s *shareSound) load() {
	s.mu.Lock()
	if s.loaded || s.loading {
		s.mu.Unlock()
		return
	}
	s.loading = true
	s.mu.Unlock()
	go func() {
		apps := native.AudioApps()
		s.mu.Lock()
		s.apps, s.loaded, s.loading = apps, true, false
		s.mu.Unlock()
		redraw.Request()
	}()
}

// windowPID is the application of a window source; while it is being looked up it is 0.
func (s *shareSound) windowPID(id string, wait bool) int {
	s.mu.Lock()
	pid, ok := s.pids[id]
	if !ok && !wait {
		if s.pids == nil {
			s.pids = map[string]int{}
		}
		s.pids[id] = 0
		go func() {
			p := native.WindowAudioPID(id)
			s.mu.Lock()
			s.pids[id] = p
			s.mu.Unlock()
			redraw.Request()
		}()
	}
	s.mu.Unlock()
	if wait && pid == 0 {
		pid = native.WindowAudioPID(id)
	}
	return pid
}

// choice is what the person picked for a source; wait lets the lookup of a window's application block.
func (s *shareSound) choice(fallback, id string, wait bool) shareaudio.Choice {
	kind, _ := native.ParseSourceID(id)
	c := shareaudio.Choice{Kind: string(kind), Support: s.supportNow(), Fallback: fallback}
	if id == "" {
		c.Kind = shareaudio.Screen
	}
	s.mu.Lock()
	pid := s.exclude
	if !s.chosen {
		pid = os.Getpid()
	}
	for _, a := range s.apps {
		if a.PID == pid {
			c.ExcludePID, c.ExcludeName = pid, a.Name
		}
	}
	if !s.loaded && pid == os.Getpid() {
		c.ExcludePID, c.ExcludeName = pid, "Harmony"
	}
	s.mu.Unlock()
	if c.Kind == shareaudio.Window {
		c.WindowPID = s.windowPID(id, wait)
	}
	return c
}

// soundHooks are the picker's sound rows and the note under them, and tell the session how to decide a share's sound.
func (sh *Shell) soundHooks(session *app.Session) (note func(native.SourceInfo) string, extra func(native.SourceInfo) widget.Component) {
	sound.reset()
	session.SetShareAudioChooser(func(id string) shareaudio.Plan {
		return shareaudio.Decide(sound.choice(sh.settings.WindowAudioFallback, id, true))
	})
	note = func(src native.SourceInfo) string {
		plan := shareaudio.Decide(sound.choice(sh.settings.WindowAudioFallback, src.ID, false))
		c := sh.context
		return c.T(plan.Note, "name", plan.Name, "reason", plan.Reason)
	}
	extra = func(src native.SourceInfo) widget.Component {
		c := sh.context
		kind := src.Kind
		support := sound.supportNow()
		switch {
		case kind == native.KindScreen && support.Exclude:
			sound.load()
			return sharepicker.SoundRow{Label: c.T("exclude_field.exclude_audio"), Dropdown: sound.excludeMenu(c)}
		case kind == native.KindWindow && !(support.App && sound.windowPID(src.ID, false) > 0):
			return sharepicker.SoundRow{Label: c.T("fallback_field.if_per_app_audio"), Segmented: sound.fallbackChoice(c, sh)}
		}
		return nil
	}
	return note, extra
}

func (s *shareSound) excludeMenu(c *widget.Context) *widget.Dropdown {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := &s.drop
	d.Options = d.Options[:0]
	d.Options = append(d.Options, widget.Option{Value: "0", Label: c.T("app.nothing_share_all_system_audio")})
	self := os.Getpid()
	d.Options = append(d.Options, widget.Option{Value: strconv.Itoa(self), Label: c.T("app.harmony_voices_soundpad_and_sounds")})
	for _, a := range s.apps {
		if !a.Self && a.PID != self {
			d.Options = append(d.Options, widget.Option{Value: strconv.Itoa(a.PID), Label: a.Name})
		}
	}
	pid := s.exclude
	if !s.chosen {
		pid = self
	}
	d.Value = strconv.Itoa(pid)
	d.OnChange = func(v string) {
		n, _ := strconv.Atoi(v)
		s.mu.Lock()
		s.exclude, s.chosen = n, true
		s.mu.Unlock()
		redraw.Request()
	}
	return d
}

func (s *shareSound) fallbackChoice(c *widget.Context, sh *Shell) *widget.Segmented {
	g := &s.seg
	if len(g.Options) == 0 {
		g.Options = []widget.Option{
			{Value: shareaudio.FallbackSilent, Label: c.T("window_audio_fallback.share_silently")},
			{Value: shareaudio.FallbackSystem, Label: c.T("window_audio_fallback.use_system_audio")},
		}
	}
	g.Value = sh.settings.WindowAudioFallback
	if g.Value == "" {
		g.Value = shareaudio.FallbackSilent
	}
	g.OnChange = func(v string) {
		sh.settings.WindowAudioFallback = v
		sh.settings.Save()
		redraw.Request()
	}
	return g
}
