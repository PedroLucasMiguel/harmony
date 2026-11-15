// Package joinsound turns an audio file into the sound played to a voice channel when somebody arrives: a mono WAV at 32 kHz,
// the one format the server can measure without a decoder, cut at ten seconds with a short fade.
package joinsound

import (
	"encoding/binary"
	"errors"
	"math"

	"harmony/v2/internal/clip"
)

const (
	MaxSeconds    = 10
	MaxSourceSize = 20 << 20
	Rate          = 32000
	sourceRate    = 48000
	fadeSeconds   = 0.12
)

var (
	ErrTooBig     = errors.New("too big")
	ErrUnreadable = errors.New("unreadable")
)

// Result is a converted sound.
type Result struct {
	WAV     []byte
	Seconds float64
	Trimmed bool
}

// Convert decodes any audio the clip package reads and writes the join sound for it.
func Convert(data []byte) (Result, error) {
	if len(data) > MaxSourceSize {
		return Result{}, ErrTooBig
	}
	stereo, err := clip.Decode(data)
	if err != nil || len(stereo) < 2 {
		return Result{}, ErrUnreadable
	}
	mono := downmix(stereo)
	total := len(mono) * Rate / sourceRate
	wanted := min(total, MaxSeconds*Rate)
	if wanted == 0 {
		return Result{}, ErrUnreadable
	}
	out := make([]float32, wanted)
	step := float64(sourceRate) / Rate
	for i := range out {
		out[i] = average(mono, float64(i)*step, step)
	}
	trimmed := total > wanted
	if trimmed {
		fade := min(wanted, int(fadeSeconds*Rate))
		for i := 0; i < fade; i++ {
			out[wanted-fade+i] *= 1 - float32(i+1)/float32(fade)
		}
	}
	return Result{WAV: encodeWAV(out), Seconds: float64(wanted) / Rate, Trimmed: trimmed}, nil
}

func downmix(stereo []int16) []float32 {
	mono := make([]float32, len(stereo)/2)
	for i := range mono {
		mono[i] = (float32(stereo[2*i]) + float32(stereo[2*i+1])) / 2 / 32768
	}
	return mono
}

// average is the mean of the source samples from at to at+span, which keeps what is above the new rate from folding back down.
func average(src []float32, at, span float64) float32 {
	from, to := int(at), min(int(math.Ceil(at+span)), len(src))
	if from >= to {
		return 0
	}
	var sum float32
	for _, v := range src[from:to] {
		sum += v
	}
	return sum / float32(to-from)
}

func encodeWAV(samples []float32) []byte {
	b := make([]byte, 44+2*len(samples))
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(36+2*len(samples)))
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], Rate)
	binary.LittleEndian.PutUint32(b[28:], Rate*2)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], uint32(2*len(samples)))
	for i, s := range samples {
		v := max(-1, min(1, s))
		if v < 0 {
			v *= 0x8000
		} else {
			v *= 0x7fff
		}
		binary.LittleEndian.PutUint16(b[44+2*i:], uint16(int16(v)))
	}
	return b
}
