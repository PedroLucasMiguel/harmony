package media

import (
	"math"
	"testing"
)

func TestDecoderOnFreshGoroutineAndLoss(t *testing.T) {
	enc, _ := newVoiceEncoder()
	pcm := make([]int16, FrameSamples)
	buf := make([]byte, maxPacketBytes)
	var packets [][]byte
	for f := 0; f < 60; f++ {
		for i := range pcm {
			pcm[i] = int16(9000 * math.Sin(2*math.Pi*440*float64(f*FrameSamples+i)/48000))
		}
		size, _ := enc.EncodeInt16(pcm, buf)
		packets = append(packets, append([]byte(nil), buf[:size]...))
	}
	done := make(chan error)
	for g := 0; g < 8; g++ {
		go func(start int) {
			dec, err := newDecoder()
			if err != nil {
				done <- err
				return
			}
			out := make([]int16, maxFrameSamples*2)
			for i := start; i < len(packets); i++ {
				if i%9 == 4 {
					if _, err := dec.DecodeInt16(nil, out[:FrameSamples*2]); err != nil {
						done <- err
						return
					}
					continue
				}
				if _, err := dec.DecodeInt16(packets[i], out); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}(g * 3)
	}
	for g := 0; g < 8; g++ {
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
}
