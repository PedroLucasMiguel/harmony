package music

import (
	"errors"
	"os"
	"sort"

	"github.com/thesyncim/gopus"

	"harmony/v2/internal/clip"
)

const (
	rate             = clip.Rate
	maxPacketSamples = 5760
	preRoll          = 80 * rate / 1000
)

var errEmpty = errors.New("the track has no sound in it")

// File is a WebM Opus file played from disk: only the list of its packets is kept, and a packet is read and decoded when its turn comes.
type File struct {
	f       *os.File
	packets []clip.OpusPacket
	starts  []uint32
	preSkip int
	total   int

	dec     *gopus.Decoder
	next    int
	discard int
	at      int
	raw     []byte
	out     []int16
	left    []int16
}

// OpenFile indexes a track's file and makes it ready to read from its start.
func OpenFile(path string) (*File, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	packets, preSkip, err := clip.IndexWebMOpus(f)
	if err != nil {
		f.Close()
		return nil, err
	}
	dec, err := gopus.NewDecoder(gopus.DefaultDecoderConfig(rate, 2))
	if err != nil {
		f.Close()
		return nil, err
	}
	t := &File{f: f, packets: packets, preSkip: preSkip, dec: dec, starts: make([]uint32, len(packets)), out: make([]int16, maxPacketSamples*2)}
	for i, p := range packets {
		t.starts[i] = uint32(t.total)
		t.total += int(p.Samples)
	}
	if t.total <= preSkip {
		f.Close()
		return nil, errEmpty
	}
	t.Seek(0)
	return t, nil
}

// Frames is the length in stereo frames.
func (t *File) Frames() int { return t.total - t.preSkip }

// Pos is the frame the next Read starts at.
func (t *File) Pos() int { return t.at }

// Close lets go of the file.
func (t *File) Close() { _ = t.f.Close() }

// Seek moves the next Read to a frame, starting the decoder a little before it so that its output has settled.
func (t *File) Seek(frame int) {
	frame = min(max(frame, 0), t.Frames())
	target := frame + t.preSkip
	i := max(sort.Search(len(t.starts), func(i int) bool { return int(t.starts[i]) > target-preRoll })-1, 0)
	t.next, t.discard, t.left, t.at = i, target-int(t.starts[min(i, len(t.starts)-1)]), nil, frame
	t.dec.Reset()
}

// Read fills dst with whole stereo frames and returns how many; zero at the end.
func (t *File) Read(dst []int16) int {
	n := 0
	for n < len(dst)-1 {
		if len(t.left) == 0 && !t.decode() {
			break
		}
		c := copy(dst[n:len(dst)&^1], t.left)
		t.left = t.left[c:]
		n += c
	}
	t.at += n / 2
	return n / 2
}

func (t *File) decode() bool {
	for t.next < len(t.packets) {
		p := t.packets[t.next]
		t.next++
		if cap(t.raw) < int(p.Size) {
			t.raw = make([]byte, p.Size)
		}
		raw := t.raw[:p.Size]
		if _, err := t.f.ReadAt(raw, p.Off); err != nil {
			continue
		}
		got, err := t.dec.DecodeInt16(raw, t.out)
		if err != nil || got == 0 {
			continue
		}
		pcm := t.out[:got*2]
		if t.discard > 0 {
			cut := min(t.discard, got)
			pcm, t.discard = pcm[cut*2:], t.discard-cut
		}
		if len(pcm) > 0 {
			t.left = pcm
			return true
		}
	}
	return false
}
