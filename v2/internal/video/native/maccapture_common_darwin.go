//go:build darwin

package native

// A running capture: sample buffers from ScreenCaptureKit or AVFoundation go to the encoder as CVPixelBuffers. A picture is
// sent again when the source goes quiet (a screen that does not change delivers nothing) so the stream keeps its key frames
// and a viewer who joins late gets a picture at once.

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ebitengine/purego/objc"
)

// mcIdleGap is how long a source may be quiet before its last picture is sent again.
const mcIdleGap = 500 * time.Millisecond

type macCapture struct {
	p     CaptureParams
	onAU  func([]byte)
	onEnd func(error)
	enc   atomic.Pointer[vtEncoder]

	closed  atomic.Bool
	endOnce sync.Once
	stop    func()

	mu    sync.Mutex // last and idle
	last  uintptr
	idle  *time.Timer
	gap   int64 // least time between pictures, for sources that run faster than asked
	lastT atomic.Int64
	call  mxCaller // the source's callback thread

	firstOnce   sync.Once
	first       chan error
	status      uintptr // SCStreamFrameInfoStatus, as a CFString
	frameStatus int32
}

func (c *macCapture) encodeParams(w, h int) EncodeParams {
	return EncodeParams{Width: w, Height: h, FPS: c.p.FPS, BitrateKbps: c.p.BitrateKbps, Matrix: c.p.Matrix, Backend: c.p.Backend}
}

func (c *macCapture) Mode() string {
	if e := c.enc.Load(); e != nil {
		return e.Mode()
	}
	return "videotoolbox"
}

// KeyFrame makes the next picture a key frame, and sends the last picture again when the source is quiet.
func (c *macCapture) KeyFrame() {
	if e := c.enc.Load(); e != nil {
		e.KeyFrame()
		c.idle.Reset(0)
	}
}

func (c *macCapture) Close() {
	c.closed.Store(true)
	c.shutdown()
}

func (c *macCapture) shutdown() {
	defer mcPool()()
	c.closed.Store(true)
	c.idle.Stop()
	if c.stop != nil {
		c.stop()
		c.stop = nil
	}
	if e := c.enc.Load(); e != nil {
		e.Close()
	}
	c.mu.Lock()
	if c.last != 0 {
		mxCFRelease(c.last)
		c.last = 0
	}
	c.mu.Unlock()
}

// end reports a capture that stopped by itself, once.
func (c *macCapture) end(err error) {
	if c.closed.Load() {
		return
	}
	c.endOnce.Do(func() { go c.onEnd(err) })
}

// frame takes one picture from the source's thread.
func (c *macCapture) frame(pb uintptr) {
	e := c.enc.Load()
	if e == nil || c.closed.Load() {
		return
	}
	if c.gap > 0 {
		now := time.Now().UnixNano()
		if now-c.lastT.Load() < c.gap {
			return
		}
		c.lastT.Store(now)
	}
	c.keep(pb)
	if err := e.EncodePixelBuffer(pb); err != nil {
		c.end(err)
	}
}

func (c *macCapture) keep(pb uintptr) {
	c.call.call(mxFn.cfRetain, pb)
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		c.call.call(mxFn.cfRelease, pb)
		return
	}
	old := c.last
	c.last = pb
	c.idle.Reset(mcIdleGap)
	c.mu.Unlock()
	if old != 0 {
		c.call.call(mxFn.cfRelease, old)
	}
}

func (c *macCapture) resend() {
	e := c.enc.Load()
	c.mu.Lock()
	pb := c.last
	if pb != 0 {
		var rc mxCaller
		rc.call(mxFn.cfRetain, pb)
		c.idle.Reset(mcIdleGap)
	}
	c.mu.Unlock()
	if pb == 0 || e == nil || c.closed.Load() {
		return
	}
	defer mxCFRelease(pb)
	if err := e.EncodePixelBuffer(pb); err != nil {
		c.end(err)
	}
}

// imageBuffer is the CVPixelBuffer of a sample buffer, or 0.
func (c *macCapture) imageBuffer(sb uintptr) uintptr {
	if sb == 0 {
		return 0
	}
	return c.call.call(mxFn.cmSampleImageBuffer, sb)
}

// screenSample is a ScreenCaptureKit sample buffer; only complete pictures are used (an idle or blank frame has none).
func (c *macCapture) screenSample(sb uintptr) {
	pb := c.imageBuffer(sb)
	if pb == 0 {
		return
	}
	if arr := c.call.call(mxFn.cmSampleAttachments, sb, 0); arr != 0 && c.call.call(mxFn.cfArrayGetCount, arr) > 0 {
		d := c.call.call(mxFn.cfArrayGetValueAtIdx, arr, 0)
		if n := c.call.call(mxFn.cfDictionaryGetValue, d, c.status); n != 0 {
			c.frameStatus = 0
			c.call.call(mxFn.cfNumberGetValue, n, mxNumSInt32, mxPtr(&c.frameStatus))
			if v := c.frameStatus; v != 0 && v != 4 { // SCFrameStatusComplete, SCFrameStatusStarted
				return
			}
		}
	}
	c.frame(pb)
}

// cameraSample is an AVFoundation sample buffer. The first one sizes the encoder.
func (c *macCapture) cameraSample(sb uintptr) {
	pb := c.imageBuffer(sb)
	if pb == 0 {
		return
	}
	if c.enc.Load() == nil {
		c.firstOnce.Do(func() { c.first <- c.openCameraEncoder(pb) })
	}
	c.frame(pb)
}

func (c *macCapture) openCameraEncoder(pb uintptr) error {
	w, h := int(c.call.call(mxFn.cvWidth, pb)), int(c.call.call(mxFn.cvHeight, pb))
	if w <= 0 || h <= 0 {
		return errors.New("the camera gave a picture of no size")
	}
	th := min(mxEven(c.p.Height), mxEven(h))
	tw := mxEven((th*w + h/2) / h)
	e, err := newCaptureEncoder(c.encodeParams(tw, th), c.onAU)
	if err != nil {
		return err
	}
	c.enc.Store(e)
	return nil
}

func mcRelease(o objc.ID) {
	if o != 0 {
		o.Send(mc.selRelease)
	}
}
