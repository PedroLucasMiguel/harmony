package audio

// A playing clip: decoded stereo samples and how far through them the output has got.
type clipPlay struct {
	pcm  []int16
	pos  int
	gain float64
	kind ClipKind
}

// ClipKind says what a clip is, so that a kind can be cut without touching the others.
type ClipKind uint8

const (
	ClipSoundpad ClipKind = iota
	ClipCue
	ClipJoinSound
)

// PlayClip adds a finished recording to the output; it is mixed in until its last sample and then dropped.
func (m *Mixer) PlayClip(pcm []int16, gain float64) { m.PlayClipKind(pcm, gain, ClipSoundpad) }

// PlayClipKind is PlayClip for a clip of the given kind.
func (m *Mixer) PlayClipKind(pcm []int16, gain float64, kind ClipKind) {
	if len(pcm) == 0 || gain <= 0 {
		return
	}
	m.mu.Lock()
	m.clips = append(m.clips, &clipPlay{pcm: pcm, gain: gain, kind: kind})
	m.mu.Unlock()
}

// StopClipsOf cuts the clips of one kind that are playing.
func (m *Mixer) StopClipsOf(kind ClipKind) {
	m.mu.Lock()
	kept := m.clips[:0]
	for _, c := range m.clips {
		if c.kind != kind {
			kept = append(kept, c)
		}
	}
	clear(m.clips[len(kept):])
	m.clips = kept
	m.mu.Unlock()
}

// Busy is whether anything is being played: a voice, or a clip that has not ended.
func (m *Mixer) Busy() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sources) > 0 || len(m.clips) > 0
}

// StopClips cuts every clip that is playing.
func (m *Mixer) StopClips() {
	m.mu.Lock()
	clear(m.clips)
	m.clips = m.clips[:0]
	m.mu.Unlock()
}

// mixClips adds the next block of every clip into acc; the caller holds the lock.
func (m *Mixer) mixClips(acc []int32) {
	kept := m.clips[:0]
	for _, c := range m.clips {
		n := min(len(acc), len(c.pcm)-c.pos)
		for i, v := range c.pcm[c.pos : c.pos+n] {
			acc[i] += int32(float64(v) * c.gain)
		}
		if c.pos += n; c.pos < len(c.pcm) {
			kept = append(kept, c)
		}
	}
	clear(m.clips[len(kept):])
	m.clips = kept
}
