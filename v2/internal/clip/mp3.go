package clip

import (
	"bytes"
	"encoding/binary"
	"io"

	"github.com/hajimehoshi/go-mp3"
)

func decodeMP3(data []byte) ([]int16, error) {
	dec, err := mp3.NewDecoder(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(dec, 4*int64(dec.SampleRate())*(MaxSeconds+1)))
	if err != nil {
		return nil, err
	}
	samples := make([]int16, len(raw)/2)
	for i := range samples {
		samples[i] = int16(binary.LittleEndian.Uint16(raw[2*i:]))
	}
	return stereo48k(samples, dec.SampleRate(), 2)
}
