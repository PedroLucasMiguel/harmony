package app

import (
	"harmony/v2/internal/audio"
	"harmony/v2/internal/store"
)

// ApplyAudioSettings puts the Voice & video page's microphone choices on the chain and the Sounds page's on the cues, at once.
func (s *Session) ApplyAudioSettings(st *store.Settings) {
	s.applyCueSettings(st)
	if s.PTTOn() != st.PushToTalk {
		s.SetPushToTalk(st.PushToTalk)
	}
	suppress := audio.SuppressOff
	switch {
	case st.MicAISuppression:
		suppress = audio.SuppressStrong
	case st.MicNoiseSuppression:
		suppress = audio.SuppressOn
	}
	s.mic.Update(func(c *audio.Config) {
		c.Gain = float64(st.MicGain) / 100
		c.Threshold = GateThreshold(st.MicSensitivity)
		c.Auto = st.MicAutoSensitivity
		c.AGC = st.MicAutoGain
		c.Suppress = suppress
	})
}
