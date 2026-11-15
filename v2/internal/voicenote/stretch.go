package voicenote

import (
	"math"
	"slices"
)

const (
	window    = 1024
	hop       = window / 2
	tolerance = hop / 2
	chunk     = 4096
	keep      = 2 * window
)

var hann = func() (w [window]float32) {
	for i := range w {
		s := math.Sin(math.Pi * (float64(i) + 0.5) / window)
		w[i] = float32(s * s)
	}
	return
}()

// reader plays a track at a speed without changing its pitch: at 1 it passes frames through, above 1 it overlaps windows taken at a faster pace, each lined up with the last where their waveforms agree (WSOLA).
type reader struct {
	track Track
	speed float64

	buf     []int16
	base    int
	eof     bool
	scratch []int16

	at      float64
	prev    int
	ola     [window * 2]float32
	pending []int16
}

func newReader(t Track) *reader {
	r := &reader{track: t, speed: 1}
	r.Seek(0)
	return r
}

// Pos is the frame of the track that the next sound read comes from.
func (r *reader) Pos() float64 { return r.at }

func (r *reader) Seek(frame int) {
	frame = min(max(frame, 0), r.track.Frames())
	r.track.Seek(frame)
	r.buf, r.base, r.eof = r.buf[:0], frame, false
	r.at, r.prev = float64(frame), -1
	clear(r.ola[:])
	r.pending = r.pending[:0]
}

// SetSpeed changes the pace from the current place on.
func (r *reader) SetSpeed(s float64) {
	if s != r.speed {
		r.speed = s
		r.Seek(int(r.at))
	}
}

// frames is the stretch of the track from one frame to another, zeros where it has ended; valid until the next call.
func (r *reader) frames(from, to int) []int16 {
	if drop := from - keep - r.base; drop > 0 {
		r.buf = append(r.buf[:0], r.buf[min(drop*2, len(r.buf)):]...)
		r.base += drop
	}
	for r.base+len(r.buf)/2 < to && !r.eof {
		start := len(r.buf)
		r.buf = slices.Grow(r.buf, chunk*2)[:start+chunk*2]
		n := r.track.Read(r.buf[start:])
		r.buf = r.buf[:start+n*2]
		r.eof = n == 0
	}
	have := r.base + len(r.buf)/2
	if to <= have {
		return r.buf[(from-r.base)*2 : (to-r.base)*2]
	}
	r.scratch = append(r.scratch[:0], r.buf[max(0, min(len(r.buf), (from-r.base)*2)):]...)
	r.scratch = append(r.scratch, make([]int16, (to-from)*2-len(r.scratch))...)
	return r.scratch
}

// Read fills dst with whole frames and returns how many; zero when the track has been played out.
func (r *reader) Read(dst []int16) int {
	want := len(dst) / 2
	if r.speed == 1 {
		n := min(want, r.track.Frames()-int(r.at))
		if n <= 0 {
			return 0
		}
		copy(dst, r.frames(int(r.at), int(r.at)+n))
		r.at += float64(n)
		return n
	}
	for len(r.pending) < want*2 && r.step() {
	}
	n := copy(dst[:want*2], r.pending) / 2
	r.pending = append(r.pending[:0], r.pending[n*2:]...)
	return n
}

// step overlaps the next window into the output and moves a hop's worth of finished sound into pending.
func (r *reader) step() bool {
	total := r.track.Frames()
	if int(r.at) >= total {
		if r.prev < 0 {
			return false
		}
		r.prev = -1
		r.emit()
		return true
	}
	pos := int(r.at)
	if r.prev >= 0 {
		pos = r.align(pos, r.prev+hop)
	}
	x := r.frames(pos, pos+window)
	for i := 0; i < window; i++ {
		w := hann[i]
		r.ola[2*i] += float32(x[2*i]) * w
		r.ola[2*i+1] += float32(x[2*i+1]) * w
	}
	r.emit()
	r.prev = pos
	r.at += r.speed * hop
	return true
}

// emit moves the first hop of the overlap buffer to the output and slides the rest down.
func (r *reader) emit() {
	for _, v := range r.ola[:hop*2] {
		r.pending = append(r.pending, int16(max(-32768, min(32767, v))))
	}
	copy(r.ola[:], r.ola[hop*2:])
	clear(r.ola[window*2-hop*2:])
}

// align picks, near where the next window should start, the start whose first hop looks most like the sound that follows the last window.
func (r *reader) align(centre, follows int) int {
	lo := max(centre-tolerance, r.base, 0)
	hi := centre + tolerance
	span := r.frames(min(lo, follows), max(hi, follows)+hop)
	origin := min(lo, follows)
	best, bestScore := centre, math.Inf(-1)
	for c := lo; c <= hi; c++ {
		var score float64
		for i := 0; i < hop; i += 2 {
			score += float64(span[2*(c-origin+i)]) * float64(span[2*(follows-origin+i)])
		}
		if score > bestScore {
			best, bestScore = c, score
		}
	}
	return best
}
