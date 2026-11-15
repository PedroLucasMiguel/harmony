package app

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/clip"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/store"
)

const (
	cueTail          = 400 * time.Millisecond
	joinSoundSeconds = 10
	joinSoundGain    = 2.2
	joinSoundKept    = 32
	joinSoundTimeout = 15 * time.Second
)

// cueState is the Sounds page's choices and the join sounds that are ready to play.
type cueState struct {
	off        atomic.Bool
	noCustom   atomic.Bool
	noMention  atomic.Bool
	percent    atomic.Int32
	mu         sync.Mutex
	joinSounds map[string][]byte
	loading    map[string]bool
	order      []string
}

func (s *Session) applyCueSettings(st *store.Settings) {
	s.cues.off.Store(!st.VoiceSounds)
	s.cues.noCustom.Store(!st.CustomJoinSounds)
	s.cues.noMention.Store(!st.MentionSound)
	s.cues.percent.Store(int32(st.SoundVolume))
}

func (s *Session) cueVolume() float64 { return float64(s.cues.percent.Load()) / 100 }

// PlayCue plays one of the voice channel cues, unless voice channel sounds are off.
func (s *Session) PlayCue(c audio.Cue) {
	if !s.cues.off.Load() {
		s.PreviewCue(c)
	}
}

// PreviewCue plays a cue whatever the Sounds page says: what a switch just turned on, heard.
func (s *Session) PreviewCue(c audio.Cue) {
	go s.playPCM(audio.SynthCue(c, s.cueVolume()), 1, audio.ClipCue)
}

// PlayMention is the sound of a message that names this person, unless do not disturb or the Sounds page silences it.
func (s *Session) PlayMention(c audio.Cue) {
	if !s.cues.noMention.Load() && s.OwnStatus() != "dnd" {
		s.PreviewCue(c)
	}
}

func (s *Session) playPCM(pcm []int16, gain float64, kind audio.ClipKind) {
	if len(pcm) == 0 {
		return
	}
	s.mu.Lock()
	inCall := s.joined != nil
	s.mu.Unlock()
	if !inCall {
		s.OpenSpeakers()
	}
	s.mixer.PlayClipKind(pcm, gain, kind)
	if !inCall {
		time.AfterFunc(time.Duration(len(pcm)/2)*time.Second/48000+cueTail, func() {
			if !s.mixer.Busy() {
				s.CloseSpeakers()
			}
		})
	}
}

func (s *Session) muteCue(wasMuted, wasDeaf bool) {
	s.mu.Lock()
	muted, deaf := s.muted, s.deafened
	s.mu.Unlock()
	switch {
	case wasDeaf && !deaf:
		s.PlayCue(audio.CueUndeafen)
	case deaf && !wasDeaf:
		s.PlayCue(audio.CueDeafen)
	case muted != wasMuted:
		if muted {
			s.PlayCue(audio.CueMute)
		} else {
			s.PlayCue(audio.CueUnmute)
		}
	}
}

func (s *Session) videoCue(kind string, on bool) {
	switch {
	case kind == "c" && on:
		s.PlayCue(audio.CueCameraOn)
	case kind == "c":
		s.PlayCue(audio.CueCameraOff)
	case on:
		s.PlayCue(audio.CueStreamStart)
	default:
		s.PlayCue(audio.CueStreamStop)
	}
}

// rosterCues plays the sounds of the room changing: somebody arriving or leaving, starting or stopping a stream.
func (s *Session) rosterCues(old, now []hclient.Member) {
	s.mu.Lock()
	me := s.me.ID
	s.mu.Unlock()
	had := make(map[int]hclient.Member, len(old))
	for _, m := range old {
		had[m.UserID] = m
	}
	here := make(map[int]bool, len(now))
	for _, m := range now {
		here[m.UserID] = true
		before, was := had[m.UserID]
		switch {
		case !was:
			s.playJoin(m.UserID, me)
		case m.UserID != me && m.Publishes("s") && !before.Publishes("s"):
			s.PlayCue(audio.CueStreamStart)
		case m.UserID != me && !m.Publishes("s") && before.Publishes("s"):
			s.PlayCue(audio.CueStreamStop)
		}
	}
	for _, m := range old {
		if !here[m.UserID] {
			s.PlayCue(audio.CueLeave)
		}
	}
	s.preloadJoinSounds()
}

// playJoin is the sound of somebody arriving: their own recording if they picked one and it is ready, and the ordinary tone otherwise.
func (s *Session) playJoin(user, me int) {
	if s.cues.off.Load() {
		return
	}
	if user != me && s.playJoinSound(user) {
		return
	}
	s.PreviewCue(audio.CueJoin)
}

// connectCue is the sound of arriving in the room yourself: your own join sound, the one everybody else hears, or the connecting tone.
func (s *Session) connectCue() {
	if s.cues.off.Load() {
		return
	}
	s.mu.Lock()
	hash := s.me.JoinSoundHash
	s.mu.Unlock()
	if hash == "" || s.cues.noCustom.Load() || !s.playJoinHash(hash) {
		s.PreviewCue(audio.CueConnect)
	}
}

func (s *Session) leftCue() {
	s.mixer.StopClipsOf(audio.ClipJoinSound)
	s.PlayCue(audio.CueDisconnect)
}

func (s *Session) joinSoundHash(user int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.members {
		if a.ID == user {
			return a.JoinSoundHash
		}
	}
	return ""
}

func (s *Session) playJoinSound(user int) bool {
	if s.cues.noCustom.Load() {
		return false
	}
	hash := s.joinSoundHash(user)
	return hash != "" && s.playJoinHash(hash)
}

// playJoinHash plays a join sound that has been fetched; one that has not is fetched for next time, and the caller falls back to the tone.
func (s *Session) playJoinHash(hash string) bool {
	s.cues.mu.Lock()
	data, ok := s.cues.joinSounds[hash]
	s.cues.mu.Unlock()
	if !ok {
		go s.fetchJoinSound(hash)
		return false
	}
	pcm, err := clip.Decode(data)
	if err != nil {
		return false
	}
	if limit := joinSoundSeconds * 48000 * 2; len(pcm) > limit {
		pcm = pcm[:limit]
	}
	go s.playPCM(pcm, s.cueVolume()*0.32*joinSoundGain, audio.ClipJoinSound)
	return true
}

// PreviewJoinSound plays what others hear when this person arrives: their own recording if they have one, and the ordinary tone otherwise.
func (s *Session) PreviewJoinSound() {
	s.mixer.StopClipsOf(audio.ClipJoinSound)
	s.mu.Lock()
	hash := s.me.JoinSoundHash
	s.mu.Unlock()
	if hash == "" || !s.playJoinHash(hash) {
		s.PreviewCue(audio.CueJoin)
	}
}

// preloadJoinSounds fetches everybody's join sound ahead of time, so that it starts the moment they arrive and not after a download.
func (s *Session) preloadJoinSounds() {
	if s.cues.off.Load() || s.cues.noCustom.Load() {
		return
	}
	s.mu.Lock()
	var hashes []string
	for _, a := range s.members {
		if a.JoinSoundHash != "" && len(hashes) < joinSoundKept {
			hashes = append(hashes, a.JoinSoundHash)
		}
	}
	s.mu.Unlock()
	for _, hash := range hashes {
		go s.fetchJoinSound(hash)
	}
}

func (s *Session) fetchJoinSound(hash string) {
	s.cues.mu.Lock()
	if _, ok := s.cues.joinSounds[hash]; ok || s.cues.loading[hash] {
		s.cues.mu.Unlock()
		return
	}
	if s.cues.loading == nil {
		s.cues.loading, s.cues.joinSounds = map[string]bool{}, map[string][]byte{}
	}
	s.cues.loading[hash] = true
	s.cues.mu.Unlock()
	ctx, cancel := context.WithTimeout(s.ctx, joinSoundTimeout)
	defer cancel()
	data, err := s.client.Download(ctx, hash, hclient.MaxJoinSoundBytes)
	s.cues.mu.Lock()
	defer s.cues.mu.Unlock()
	delete(s.cues.loading, hash)
	if err != nil {
		return
	}
	if len(s.cues.order) >= joinSoundKept {
		delete(s.cues.joinSounds, s.cues.order[0])
		s.cues.order = s.cues.order[1:]
	}
	s.cues.joinSounds[hash] = data
	s.cues.order = append(s.cues.order, hash)
}
