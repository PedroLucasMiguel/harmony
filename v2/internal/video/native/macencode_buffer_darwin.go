//go:build darwin

package native

// What a capture needs of the encoder: pictures that already are CVPixelBuffers, passed on without a copy when they are
// in the session's format and size and coded with this encoder's matrix, and converted or scaled by the GPU when not.

import (
	"errors"
	"time"
)

// newCaptureEncoder makes an encoder for CVPixelBuffers from a capture.
func newCaptureEncoder(p EncodeParams, onAU func([]byte)) (*vtEncoder, error) {
	return newVTEncoder(p, false, onAU)
}

func (e *vtEncoder) pts() cmTime {
	return cmTime{Value: int64(time.Since(e.start)), Scale: 1_000_000_000, Flags: 1}
}

// matches says whether pb can go to the session as it is.
func (e *vtEncoder) matches(pb uintptr) bool {
	c := &e.sc
	if int(c.call(mxFn.cvWidth, pb)) != e.p.Width || int(c.call(mxFn.cvHeight, pb)) != e.p.Height || uint32(c.call(mxFn.cvPixelFormat, pb)) != mxFmt420v {
		return false
	}
	m := c.call(mxFn.cvBufferGetAttachment, pb, mx.kMatrix, 0)
	return m == 0 || c.call(mxFn.cfEqual, m, e.mat)&0xff != 0
}

// EncodePixelBuffer sends one picture; the caller keeps its reference. A picture the session has no room for is dropped.
func (e *vtEncoder) EncodePixelBuffer(pb uintptr) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed.Load() {
		return errors.New("encoder is closed")
	}
	if e.inFlight.Load() >= mxMaxInFlight {
		e.stat.dropped.Add(1)
		return nil
	}
	if e.matches(pb) {
		return e.submit(pb, e.pts())
	}
	if e.xfer == 0 {
		if err := e.openTransfer(); err != nil {
			return err
		}
	}
	e.pbOut = 0
	if st := int32(e.sc.call(mxFn.cvPoolCreateBuffer, 0, e.pool, mxPtr(&e.pbOut))); st != 0 || e.pbOut == 0 {
		return mxStatus("CVPixelBufferPoolCreatePixelBuffer", st)
	}
	out := e.pbOut
	defer e.sc.call(mxFn.cfRelease, out)
	e.tag(out)
	if st := int32(e.sc.call(mxFn.vtXferRun, e.xfer, pb, out)); st != 0 {
		return mxStatus("VTPixelTransferSessionTransferImage", st)
	}
	return e.submit(out, e.pts())
}
