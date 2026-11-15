package media

import (
	"github.com/thesyncim/gopus"
)

const (
	voiceBitrate    = 40000
	voiceComplexity = 6
	maxPacketBytes  = 1500
	maxFrameSamples = 5760
)

// gopus replaced libopus transpiled to Go, which aborted on the first decode of any new goroutine.
func newVoiceEncoder() (*gopus.Encoder, error) {
	enc, err := gopus.NewEncoder(gopus.EncoderConfig{SampleRate: SampleRate, Channels: 1, Application: gopus.ApplicationVoIP})
	if err != nil {
		return nil, err
	}
	if err := enc.SetFrameSize(FrameSamples); err != nil {
		return nil, err
	}
	_ = enc.SetBitrate(voiceBitrate)
	_ = enc.SetComplexity(voiceComplexity)
	return enc, nil
}

func newDecoder() (*gopus.Decoder, error) {
	return gopus.NewDecoder(gopus.DefaultDecoderConfig(SampleRate, 2))
}
