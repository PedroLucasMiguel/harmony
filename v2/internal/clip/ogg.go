package clip

import (
	"bytes"
	"math"

	"github.com/jfreymuth/oggvorbis"
)

func decodeOgg(data []byte) ([]int16, error) {
	packets := oggPackets(data)
	if len(packets) > 1 && bytes.HasPrefix(packets[0], []byte("OpusHead")) {
		skip, err := opusPreSkip(packets[0])
		if err != nil {
			return nil, err
		}
		return decodeOpus(packets[2:], skip)
	}
	return decodeVorbis(data)
}

// oggPackets splits an Ogg stream into its packets; a packet is a run of segments that ends at the first one shorter than 255.
func oggPackets(data []byte) [][]byte {
	var packets [][]byte
	var partial []byte
	for len(data) >= 27 && string(data[:4]) == "OggS" {
		count := int(data[26])
		if len(data) < 27+count {
			break
		}
		table := data[27 : 27+count]
		body := data[27+count:]
		for _, size := range table {
			n := min(int(size), len(body))
			partial = append(partial, body[:n]...)
			body = body[n:]
			if size < 255 {
				packets = append(packets, partial)
				partial = nil
			}
		}
		data = body
	}
	return packets
}

func decodeVorbis(data []byte) ([]int16, error) {
	r, err := oggvorbis.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	channels := r.Channels()
	if length := r.Length(); length > MaxSeconds*int64(r.SampleRate()) {
		return nil, ErrTooLong
	}
	var samples []int16
	block := make([]float32, 4096*channels)
	for {
		n, err := r.Read(block)
		for _, v := range block[:n] {
			samples = append(samples, clamp16(float64(v)*math.MaxInt16))
		}
		if err != nil || n == 0 {
			break
		}
	}
	return stereo48k(samples, r.SampleRate(), channels)
}
