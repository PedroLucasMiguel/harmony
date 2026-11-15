package store

// ShareAudioSettings is how shares sound, kept between sessions: how loud each person's screen share is played, by server
// address and then account (as the Electron client's streamVolumes), and what a window share does when that application's
// own sound cannot be captured ("silent" or "system").
type ShareAudioSettings struct {
	StreamVolumes       map[string]map[int]float64 `json:"streamVolumes,omitempty"`
	WindowAudioFallback string                     `json:"windowAudioFallback,omitempty"`
}

// StreamVolumesOf is what is kept of how loud each person's share is on a server.
func (s *Settings) StreamVolumesOf(serverURL string) map[int]float64 {
	return s.StreamVolumes[ServerKey(serverURL)]
}

// SetStreamVolume keeps how loud somebody's share is on a server; the usual volume is forgotten.
func (s *Settings) SetStreamVolume(serverURL string, user int, gain float64) {
	key := ServerKey(serverURL)
	if gain == 1 {
		delete(s.StreamVolumes[key], user)
		return
	}
	if s.StreamVolumes == nil {
		s.StreamVolumes = map[string]map[int]float64{}
	}
	if s.StreamVolumes[key] == nil {
		s.StreamVolumes[key] = map[int]float64{}
	}
	s.StreamVolumes[key][user] = gain
}
