package store

// PeerVolume is how loud one person is played and whether they are muted, as the Electron client keeps it.
type PeerVolume struct {
	Gain  float64 `json:"gain"`
	Muted bool    `json:"muted"`
}

// PeerVolumesOf is what is kept of how loud each person is on a server, by account id.
func (s *Settings) PeerVolumesOf(serverURL string) map[int]PeerVolume {
	return s.PeerVolumes[ServerKey(serverURL)]
}

// SetPeerVolume keeps how loud somebody is on a server; a person at the usual volume and not muted is forgotten.
func (s *Settings) SetPeerVolume(serverURL string, user int, v PeerVolume) {
	key := ServerKey(serverURL)
	if v.Gain == 1 && !v.Muted {
		delete(s.PeerVolumes[key], user)
		return
	}
	if s.PeerVolumes == nil {
		s.PeerVolumes = map[string]map[int]PeerVolume{}
	}
	if s.PeerVolumes[key] == nil {
		s.PeerVolumes[key] = map[int]PeerVolume{}
	}
	s.PeerVolumes[key][user] = v
}
