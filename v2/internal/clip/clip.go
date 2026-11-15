// Package clip decodes the audio files a server keeps as soundpad clips into 48 kHz stereo samples.
package clip

import (
	"bytes"
	"errors"
)

const (
	// Rate is the sample rate every decoded clip comes out at, the mixer's.
	Rate = 48000
	// MaxSeconds is the longest clip that is decoded; a longer one would need more memory than a sound effect is worth.
	MaxSeconds = 180
	maxSamples = Rate * MaxSeconds * 2
)

var (
	ErrUnsupported = errors.New("this audio format is not supported")
	ErrTooLong     = errors.New("the clip is too long to play")
)

// Decode returns interleaved stereo samples at Rate, whatever the file is: WAV, MP3, Ogg (Vorbis or Opus) or WebM (Opus).
func Decode(data []byte) ([]int16, error) {
	switch {
	case bytes.HasPrefix(data, []byte("RIFF")):
		return decodeWAV(data)
	case bytes.HasPrefix(data, []byte("OggS")):
		return decodeOgg(data)
	case bytes.HasPrefix(data, []byte{0x1A, 0x45, 0xDF, 0xA3}):
		return decodeWebM(data)
	case bytes.HasPrefix(data, []byte("ID3")), len(data) > 2 && data[0] == 0xFF && data[1]&0xE0 == 0xE0:
		return decodeMP3(data)
	}
	return nil, ErrUnsupported
}
