package channels

import (
	"math"

	"harmony/v2/internal/app"
	"harmony/v2/internal/ui/widget"
)

const streamGainPercentMax = int(app.MaxStreamGain * 100)

// tileSound gives a screen share's tile its sound controls: for somebody else's the volume slider, kept per person, and for
// your own the button that plays it to you.
func (s *Screen) tileSound(t *widget.VideoTile, st app.Stream, v *streamView) {
	if st.Kind != kindScreen {
		return
	}
	t.NoAudio = st.NoAudio
	if st.Own {
		t.Monitor, t.Monitoring, t.CanMonitor = true, s.Session.ShareMonitoring(), s.Session.CanMonitorShare()
		return
	}
	if v.volume.Max == 0 {
		mid := st.Mid
		v.volume = widget.Slider{Max: streamGainPercentMax, Step: 1}
		v.volume.OnChange = func(percent int) { s.setStreamGain(mid, float64(percent)/100) }
		v.volume.OnCommit = func(int) { s.Settings.Save() }
	}
	v.volume.Value = int(math.Round(st.Gain * 100))
	t.Volume, t.Level = &v.volume, v.volume.Value
}

// setStreamGain plays a share at that many times its own volume and keeps it for the person, in the settings file the next
// time it is saved.
func (s *Screen) setStreamGain(mid int, gain float64) {
	user := s.Session.SetStreamGain(mid, gain)
	s.Settings.SetStreamVolume(s.Server.URL, user, gain)
}

// toggleStreamMute mutes a share, or brings it back to the volume it is sent at.
func (s *Screen) toggleStreamMute(st app.Stream) {
	next := 0.0
	if st.Gain == 0 {
		next = 1
	}
	s.setStreamGain(st.Mid, next)
	s.Settings.Save()
}

func (s *Screen) toggleShareMonitor() {
	s.fail(s.Session.SetShareMonitor(!s.Session.ShareMonitoring()))
}

// loadStreamVolumes hands the session what was kept of how loud each person's share is, once it knows who is signed in.
func (s *Screen) loadStreamVolumes() {
	s.Session.LoadStreamPrefs(s.Settings.StreamVolumesOf(s.Server.URL))
}
