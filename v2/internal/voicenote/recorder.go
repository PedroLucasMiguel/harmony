package voicenote

import (
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/thesyncim/gopus"
)

const (
	bitrate    = 32000
	complexity = 6
	frame      = rate / 50
	maxPacket  = 1500
	queued     = 256
	maxSamples = MaxSeconds * rate
)

// ErrTooShort is what Finish says of a recording that was a slip of the finger.
var ErrTooShort = errors.New("the recording is too short")

// File is a finished recording, ready to be uploaded or sealed.
type File struct {
	Name     string
	Data     []byte
	Duration time.Duration
}

// Recorder turns the microphone's 20 ms frames into a WebM file. Feed is cheap and safe to call from the capture thread; the encoding is done on a goroutine of its own.
type Recorder struct {
	frames  chan []int16
	done    chan struct{}
	level   atomic.Uint64
	samples atomic.Int64
	paused  atomic.Bool

	mu     sync.Mutex
	closed bool
	mux    *Muxer
	err    error
}

// NewRecorder starts the encoder.
func NewRecorder() (*Recorder, error) {
	enc, err := gopus.NewEncoder(gopus.EncoderConfig{SampleRate: rate, Channels: 1, Application: gopus.ApplicationVoIP})
	if err != nil {
		return nil, err
	}
	if err := enc.SetFrameSize(frame); err != nil {
		return nil, err
	}
	_ = enc.SetBitrate(bitrate)
	_ = enc.SetComplexity(complexity)
	r := &Recorder{frames: make(chan []int16, queued), done: make(chan struct{}), mux: NewMuxer(enc.Lookahead())}
	go r.encode(enc)
	return r, nil
}

// Feed gives the recorder a block of microphone samples (mono, 48 kHz); it is dropped while paused or once the recording is as long as it may be.
func (r *Recorder) Feed(samples []int16) {
	var sum float64
	for _, v := range samples {
		sum += float64(v) * float64(v)
	}
	r.level.Store(math.Float64bits(math.Sqrt(sum/float64(max(len(samples), 1))) / 32768))
	if r.paused.Load() {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	cp := make([]int16, len(samples))
	copy(cp, samples)
	select {
	case r.frames <- cp:
	default:
	}
}

// Level is how loud it is right now, from 0 to 1; nothing while paused.
func (r *Recorder) Level() float64 {
	if r.paused.Load() {
		return 0
	}
	return math.Float64frombits(r.level.Load())
}

// Elapsed is how much has been recorded.
func (r *Recorder) Elapsed() time.Duration {
	return time.Duration(r.samples.Load()) * time.Second / rate
}

// Full says whether the recording has reached the longest there is.
func (r *Recorder) Full() bool { return r.samples.Load() >= maxSamples }

func (r *Recorder) Paused() bool { return r.paused.Load() }

func (r *Recorder) SetPaused(on bool) { r.paused.Store(on) }

func (r *Recorder) encode(enc *gopus.Encoder) {
	defer close(r.done)
	pending := make([]int16, 0, 2*frame)
	packet := make([]byte, maxPacket)
	for samples := range r.frames {
		pending = append(pending, samples...)
		for len(pending) >= frame {
			n, err := enc.EncodeInt16(pending[:frame], packet)
			pending = append(pending[:0], pending[frame:]...)
			if err != nil {
				r.mu.Lock()
				r.err = err
				r.mu.Unlock()
				continue
			}
			r.mux.Add(append([]byte(nil), packet[:n]...), frame)
			if r.samples.Add(frame) >= maxSamples {
				r.paused.Store(true)
			}
		}
	}
}

// Finish ends the recording and returns the file; a recording shorter than MinDuration is an error.
func (r *Recorder) Finish() (File, error) {
	r.stop()
	if d := r.Elapsed(); d < MinDuration {
		return File{}, ErrTooShort
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return File{}, r.err
	}
	return File{Name: Name(time.Now()), Data: r.mux.Bytes(), Duration: r.Elapsed()}, nil
}

// Cancel throws the recording away.
func (r *Recorder) Cancel() { r.stop() }

func (r *Recorder) stop() {
	r.mu.Lock()
	if !r.closed {
		r.closed = true
		close(r.frames)
	}
	r.mu.Unlock()
	<-r.done
}
