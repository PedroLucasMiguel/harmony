package app

import "sync"

// MaxPeerGain is the loudest anybody is played, 350%.
const MaxPeerGain = 3.5

// PeerPref is how one person is heard here: how loud, and whether they are silenced for this listener only.
type PeerPref struct {
	Gain  float64 `json:"gain"`
	Muted bool    `json:"muted"`
}

// PeerVolumes is what is kept of how loud each person is, by account id; the screen saves it with the settings.
type peerVolumes struct {
	mu    sync.Mutex
	prefs map[int]PeerPref
}

func (v *peerVolumes) get(user int) PeerPref {
	v.mu.Lock()
	defer v.mu.Unlock()
	if p, ok := v.prefs[user]; ok {
		return p
	}
	return PeerPref{Gain: 1}
}

func (v *peerVolumes) put(user int, p PeerPref) {
	v.mu.Lock()
	if v.prefs == nil {
		v.prefs = map[int]PeerPref{}
	}
	v.prefs[user] = p
	v.mu.Unlock()
}

// PeerPref is how somebody is heard.
func (s *Session) PeerPref(user int) PeerPref { return s.peerVol.get(user) }

// LoadPeerPrefs replaces everybody's level with what was kept for this server.
func (s *Session) LoadPeerPrefs(saved map[int]PeerPref) {
	s.peerVol.mu.Lock()
	s.peerVol.prefs = make(map[int]PeerPref, len(saved))
	for user, p := range saved {
		s.peerVol.prefs[user] = PeerPref{Gain: min(max(p.Gain, 0), MaxPeerGain), Muted: p.Muted}
	}
	s.peerVol.mu.Unlock()
	s.mu.Lock()
	for _, p := range s.peers {
		p.src.SetGain(s.peerGain(p.user))
	}
	s.mu.Unlock()
}

// SetPeerGain plays somebody at that many times their own volume; turning somebody up from silence also unmutes them.
func (s *Session) SetPeerGain(user int, gain float64) PeerPref {
	p := s.peerVol.get(user)
	p.Gain = min(max(gain, 0), MaxPeerGain)
	if p.Gain > 0 {
		p.Muted = false
	}
	s.peerVol.put(user, p)
	s.applyPeer(user)
	return p
}

// SetPeerMuted silences somebody for this listener alone; unmuting somebody left at zero brings them back to their own volume.
func (s *Session) SetPeerMuted(user int, muted bool) PeerPref {
	p := s.peerVol.get(user)
	p.Muted = muted
	if !muted && p.Gain == 0 {
		p.Gain = 1
	}
	s.peerVol.put(user, p)
	s.applyPeer(user)
	return p
}

func (s *Session) peerGain(user int) float64 {
	if p := s.peerVol.get(user); !p.Muted {
		return p.Gain
	}
	return 0
}

func (s *Session) applyPeer(user int) {
	gain := s.peerGain(user)
	s.mu.Lock()
	for _, p := range s.peers {
		if p.user == user {
			p.src.SetGain(gain)
		}
	}
	s.mu.Unlock()
	s.changed()
}
