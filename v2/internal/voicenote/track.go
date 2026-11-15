package voicenote

import (
	"bytes"
	"errors"
	"sort"

	"github.com/thesyncim/gopus"

	"harmony/v2/internal/clip"
)

const (
	maxPacketSamples = 5760
	preRoll          = 80 * rate / 1000
)

var errEmpty = errors.New("the sound has nothing in it")

// Track is a sound that can be read from any point: interleaved stereo at 48 kHz.
type Track interface {
	// Frames is the length in stereo frames.
	Frames() int
	// Seek moves the next Read to a frame.
	Seek(frame int)
	// Read fills dst with whole frames and returns how many; zero at the end.
	Read(dst []int16) int
	// Size is about how many bytes the track holds.
	Size() int
}

// Open makes a track of a sound file: WebM Opus is decoded as it is read, anything else is decoded whole.
func Open(data []byte) (Track, error) {
	if bytes.HasPrefix(data, []byte{0x1A, 0x45, 0xDF, 0xA3}) {
		return openOpus(data)
	}
	pcm, err := clip.Decode(data)
	if err != nil {
		return nil, err
	}
	if len(pcm) == 0 {
		return nil, errEmpty
	}
	return &pcmTrack{pcm: pcm}, nil
}

type pcmTrack struct {
	pcm []int16
	at  int
}

func (t *pcmTrack) Frames() int { return len(t.pcm) / 2 }
func (t *pcmTrack) Size() int   { return len(t.pcm) * 2 }
func (t *pcmTrack) Seek(frame int) {
	t.at = min(max(frame, 0), t.Frames()) * 2
}

func (t *pcmTrack) Read(dst []int16) int {
	n := copy(dst, t.pcm[t.at:]) &^ 1
	t.at += n
	return n / 2
}

// opusTrack keeps the compressed packets and decodes the ones asked for; a quarter hour is a few megabytes, where its samples would be hundreds.
type opusTrack struct {
	data    []byte
	packets [][]byte
	starts  []int
	preSkip int
	total   int

	dec     *gopus.Decoder
	next    int
	discard int
	out     []int16
	left    []int16
}

func openOpus(data []byte) (*opusTrack, error) {
	packets, preSkip, err := clip.WebMOpus(data)
	if err != nil {
		return nil, err
	}
	dec, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(rate, 2))
	if err != nil {
		return nil, err
	}
	t := &opusTrack{data: data, packets: packets, preSkip: preSkip, dec: dec, out: make([]int16, maxPacketSamples*2), starts: make([]int, len(packets))}
	for i, p := range packets {
		t.starts[i] = t.total
		t.total += packetSamples(p)
	}
	if t.total <= preSkip {
		return nil, errEmpty
	}
	t.discard = preSkip
	return t, nil
}

func (t *opusTrack) Frames() int { return t.total - t.preSkip }
func (t *opusTrack) Size() int {
	return len(t.data) + 24*len(t.packets) + 8*len(t.starts) + 4*len(t.out)
}

func (t *opusTrack) Seek(frame int) {
	target := min(max(frame, 0), t.Frames()) + t.preSkip
	i := sort.Search(len(t.starts), func(i int) bool { return t.starts[i] > target-preRoll }) - 1
	t.next, t.discard, t.left = max(i, 0), target-t.starts[max(i, 0)], nil
	t.dec.Reset()
}

func (t *opusTrack) Read(dst []int16) int {
	n := 0
	for n < len(dst)-1 {
		if len(t.left) == 0 && !t.decode() {
			break
		}
		c := copy(dst[n:len(dst)&^1], t.left)
		t.left = t.left[c:]
		n += c
	}
	return n / 2
}

func (t *opusTrack) decode() bool {
	for t.next < len(t.packets) {
		got, err := t.dec.DecodeInt16(t.packets[t.next], t.out)
		t.next++
		if err != nil || got == 0 {
			continue
		}
		pcm := t.out[:got*2]
		if t.discard > 0 {
			cut := min(t.discard*2, len(pcm))
			pcm, t.discard = pcm[cut:], t.discard-cut/2
		}
		if len(pcm) > 0 {
			t.left = pcm
			return true
		}
	}
	return false
}
