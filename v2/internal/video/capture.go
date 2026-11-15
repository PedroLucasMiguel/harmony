// Package video captures and encodes a screen or camera to H.264 and decodes it back, on the system's own codecs (see
// package native); the sources "bars" and "test" are pictures drawn in Go.
package video

import (
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/video/native"
)

// ErrNoPicture is what FirstAU returns when nothing came in time.
var ErrNoPicture = errors.New("no picture arrived")

// queued is how many access units wait for the reader of a capture before the oldest is dropped.
const queued = 4

type CaptureOptions struct {
	// Source is "screen", "camera", "test" (a moving picture with a frame counter) "bars" (the colour bars) or "black" (a camera that gives nothing).
	Source  string
	Camera  string
	Display int
	// SourceID is a native.SourceInfo.ID of a screen or window; it wins over Display.
	SourceID string
	Height   int
	// Native asks for the source's own size, Height being the fallback where the system cannot say.
	Native      bool
	FPS         int
	BitrateKbps int
	// Encoder is the codec backend, as native.EncodeParams.Backend says: "" for automatic.
	Encoder string
}

func (o *CaptureOptions) defaults() {
	if o.Source == "" {
		o.Source = "screen"
	}
	if o.Height == 0 {
		o.Height = 720
	}
	if o.FPS == 0 {
		o.FPS = 30
	}
	if o.BitrateKbps == 0 {
		o.BitrateKbps = 2500
	}
}

// Capture is a running capture whose access units are taken one by one with NextAU.
type Capture struct {
	q     *auQueue
	mode  string
	close func()
	once  sync.Once

	stats    func() native.EncodeStats
	keyFrame atomic.Pointer[func()]
	lastKey  atomic.Int64
}

// StartCapture opens the source and starts encoding. A screen or camera that cannot be opened, or that the person has
// not allowed, is an error here.
func StartCapture(opts CaptureOptions) (*Capture, error) {
	opts.defaults()
	c := &Capture{q: newAUQueue(queued)}
	c.q.onDrop = c.dropped
	switch opts.Source {
	case "screen", "camera":
		if opts.Source == "camera" && opts.Camera != "" && !slices.ContainsFunc(native.Cameras(), func(i native.CameraInfo) bool { return i.ID == opts.Camera }) {
			opts.Camera = ""
		}
		nc, err := native.StartCapture(native.CaptureParams{
			Source: native.Source(opts.Source), Display: opts.Display, SourceID: opts.SourceID, Native: opts.Native, CameraID: opts.Camera, Height: opts.Height, FPS: opts.FPS,
			BitrateKbps: opts.BitrateKbps, Matrix: opts.colour().Matrix, Backend: opts.Encoder,
		}, c.q.push, c.q.fail)
		if err != nil {
			return nil, err
		}
		c.mode, c.close = nc.Mode(), nc.Close
		if sr, ok := nc.(native.StatsReader); ok {
			c.stats = sr.Stats
		}
		if k, ok := nc.(interface{ KeyFrame() }); ok {
			c.setKeyFrame(k.KeyFrame)
		}
	case "test", "bars", "black":
		ps, err := startPattern(opts, c.q.push)
		if err != nil {
			return nil, err
		}
		c.mode, c.close = ps.mode(), ps.close
		c.setKeyFrame(ps.enc.KeyFrame)
	default:
		return nil, fmt.Errorf("unknown capture source %q", opts.Source)
	}
	return c, nil
}

func (c *Capture) setKeyFrame(f func()) { c.keyFrame.Store(&f) }

// keyGap is the least time between the key frames asked for after dropped pictures.
const keyGap = time.Second

// dropped asks the encoder for a key frame, so that the picture recovers at once after a dropped one; at most one a second.
func (c *Capture) dropped() {
	now := time.Now().UnixNano()
	if last := c.lastKey.Load(); now-last < int64(keyGap) || !c.lastKey.CompareAndSwap(last, now) {
		return
	}
	if k := c.keyFrame.Load(); k != nil {
		(*k)()
	}
}

// KeyFrame asks the encoder for a key frame now.
func (c *Capture) KeyFrame() {
	if k := c.keyFrame.Load(); k != nil {
		(*k)()
	}
}

// Stats are the encoder's running totals; ok is false for a capture whose encoder does not report them.
func (c *Capture) Stats() (native.EncodeStats, bool) {
	if c.stats == nil {
		return native.EncodeStats{}, false
	}
	return c.stats(), true
}

// Mode is the codec in use, for the log.
func (c *Capture) Mode() string { return c.mode }

// NextAU waits for the next access unit, which is valid until the next call. It returns an error when the capture has
// ended, by itself or by Close.
func (c *Capture) NextAU() ([]byte, error) {
	au, _, err := c.q.next(0)
	return au, err
}

// FirstAU waits for the first picture, so a camera or screen that cannot be opened is an error now rather than a silent stream later.
func (c *Capture) FirstAU(wait time.Duration) ([]byte, error) {
	au, ok, err := c.q.next(wait)
	if err != nil {
		c.Close()
		return nil, err
	}
	if !ok {
		c.Close()
		return nil, ErrNoPicture
	}
	return au, nil
}

// Close stops the capture and ends NextAU; it can be called more than once.
func (c *Capture) Close() {
	c.once.Do(func() {
		c.q.close()
		c.close()
	})
}
