package clip

import (
	"encoding/binary"
	"errors"

	"github.com/thesyncim/gopus"
)

const maxOpusFrame = 5760

var errNoOpusHead = errors.New("the Opus stream has no header")

// opusPreSkip reads the number of samples at the start of the stream that are decoder warm-up, from an OpusHead packet.
func opusPreSkip(head []byte) (int, error) {
	if len(head) < 12 || string(head[:8]) != "OpusHead" {
		return 0, errNoOpusHead
	}
	return int(binary.LittleEndian.Uint16(head[10:12])), nil
}

func decodeOpus(packets [][]byte, preSkip int) ([]int16, error) {
	dec, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(Rate, 2))
	if err != nil {
		return nil, err
	}
	var out []int16
	frame := make([]int16, maxOpusFrame*2)
	skip := preSkip * 2
	for _, p := range packets {
		n, err := dec.DecodeInt16(p, frame)
		if err != nil {
			continue
		}
		pcm := frame[:n*2]
		if skip > 0 {
			cut := min(skip, len(pcm))
			pcm, skip = pcm[cut:], skip-cut
		}
		out = append(out, pcm...)
		if len(out) > maxSamples {
			return nil, ErrTooLong
		}
	}
	return out, nil
}
