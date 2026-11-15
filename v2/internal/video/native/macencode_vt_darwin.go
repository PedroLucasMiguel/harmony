//go:build darwin

package native

// A VTCompressionSession that makes the H.264 stream: pictures in (BGRA from Go, or CVPixelBuffers from a capture), Annex
// B access units out. The session's one output callback is shared by every encoder and finds its encoder by a handle.

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ebitengine/purego"
)

// mxMaxInFlight is how many pictures the session may hold; the next one is dropped instead of queued.
const mxMaxInFlight = 3

var (
	mxEncoders    sync.Map // handle -> *vtEncoder
	mxNextHandle  atomic.Uintptr
	mxCallback    uintptr
	mxCallbackOne sync.Once
)

type vtEncoder struct {
	handle   uintptr
	p        EncodeParams
	onAU     func([]byte)
	inPool   uintptr // BGRA pictures from Go, when this encoder takes them
	sess     uintptr
	hw       bool
	wantHW   bool
	props    uintptr
	forceKey atomic.Bool
	inFlight atomic.Int32
	stat     mxStat
	closed   atomic.Bool
	start    time.Time

	mu       sync.Mutex // one submit at a time, and not while closing
	pool     uintptr
	xfer     uintptr // scaler for sources of another size than the session's
	prim     uintptr
	mat      uintptr
	scratch  []byte
	bridge   []byte
	psPtr    uintptr
	psSize   int
	psCount  int
	nalLen   int32
	cbLen    int
	cbTotal  int
	cbData   uintptr
	pbIn     uintptr // out-parameters of C calls live here: a Go stack variable may move while the call is made
	pbOut    uintptr
	infoOut  uint32
	duration cmTime
	sc, cc   mxCaller // the submitting side (under mu) and the callback side
}

func mxEven(v int) int { return v &^ 1 }

// newVTEncoder makes a session for pictures of srcFmt at p.Width x p.Height. p.Backend "" asks for the hardware encoder
// first and the system's software one when the hardware refuses; "videotoolbox" only the hardware; "software" only
// the software one.
func newVTEncoder(p EncodeParams, fromGo bool, onAU func([]byte)) (*vtEncoder, error) {
	if err := mxLoad(); err != nil {
		return nil, err
	}
	if p.Width <= 0 || p.Height <= 0 || p.Width&1 != 0 || p.Height&1 != 0 {
		return nil, fmt.Errorf("encoder size %dx%d must be even and positive", p.Width, p.Height)
	}
	if p.FPS <= 0 {
		p.FPS = 30
	}
	var modes []bool // hardware or not, in the order to try
	switch p.Backend {
	case Auto:
		modes = []bool{true, false}
	case VideoToolbox:
		modes = []bool{true}
	case Software:
		modes = []bool{false}
	default:
		return nil, fmt.Errorf("encoder %q is not available on macOS", p.Backend)
	}
	var err error
	for _, hw := range modes {
		var e *vtEncoder
		if e, err = openVTSession(p, fromGo, hw, onAU); err == nil {
			return e, nil
		}
	}
	return nil, err
}

func openVTSession(p EncodeParams, fromGo, hw bool, onAU func([]byte)) (*vtEncoder, error) {
	mxCallbackOne.Do(func() { mxCallback = purego.NewCallback(mxOutput) })
	e := &vtEncoder{wantHW: hw, p: p, onAU: onAU, start: time.Now(), scratch: make([]byte, 0, 1<<17)}
	e.duration = cmTime{Value: 1, Scale: int32(p.FPS), Flags: 1}
	e.handle = mxNextHandle.Add(1)

	var spec uintptr
	if hw {
		spec = mxDict(mx.kSpecEnableHW, mx.cfTrue, mx.kSpecRequireHW, mx.cfTrue)
	} else {
		spec = mxDict(mx.kSpecEnableHW, mx.cfFalse)
	}
	w, h, f := mxInt32(int32(p.Width)), mxInt32(int32(p.Height)), mxInt32(mxFmt420v)
	iosurf := mxDict()
	src := mxDict(mx.kPBFormat, f, mx.kPBWidth, w, mx.kPBHeight, h, mx.kPBIOSurface, iosurf)
	defer func() {
		for _, o := range []uintptr{spec, w, h, f, iosurf, src} {
			mxCFRelease(o)
		}
	}()

	mxEncoders.Store(e.handle, e)
	st := mx.vtCreate(0, int32(p.Width), int32(p.Height), 0x61766331 /* 'avc1' */, spec, src, 0, mxCallback, e.handle, &e.sess)
	if st != 0 {
		mxEncoders.Delete(e.handle)
		if hw {
			return nil, fmt.Errorf("the graphics hardware cannot encode H.264 at %dx%d (OSStatus %d)", p.Width, p.Height, st)
		}
		return nil, mxStatus("VTCompressionSessionCreate", st)
	}
	var err error
	if err = e.configure(); err != nil {
		e.Close()
		return nil, err
	}
	var using uintptr
	if mx.vtCopyProperty(e.sess, mx.kUsingHW, 0, &using) == 0 && using != 0 {
		e.hw = mxBool(using)
		mxCFRelease(using)
	}
	if hw && !e.hw {
		e.Close()
		return nil, errors.New("VideoToolbox gave a software encoder where the hardware was asked for")
	}
	e.props = mxDict(mx.kForceKey, mx.cfTrue)
	e.setColour()
	e.set(mx.kSessPrimaries, e.prim)
	e.set(mx.kSessTransfer, mx.vTransfer709)
	e.set(mx.kSessMatrix, e.mat)
	if e.pool, err = mxNewPool(p.Width, p.Height, mxFmt420v); err != nil {
		e.Close()
		return nil, err
	}
	if fromGo {
		if e.inPool, err = mxNewPool(p.Width, p.Height, mxFmtBGRA); err != nil {
			e.Close()
			return nil, err
		}
		if err = e.openTransfer(); err != nil {
			e.Close()
			return nil, err
		}
	}
	return e, nil
}

func (e *vtEncoder) set(key, val uintptr) int32 { return mx.vtSetProperty(e.sess, key, val) }

func (e *vtEncoder) setNum(key uintptr, v int32) {
	n := mxInt32(v)
	e.set(key, n)
	mxCFRelease(n)
}

func (e *vtEncoder) configure() error {
	e.set(mx.kRealTime, mx.cfTrue)
	e.set(mx.kReorder, mx.cfFalse)
	e.set(mx.kPrioritize, mx.cfTrue)
	e.setNum(mx.kMaxDelay, 0)
	profiled := false
	levels := []uintptr{mx.vProfileHigh, mx.vProfileMain, mx.vProfileCB, mx.vProfileBase}
	if !e.wantHW {
		// The software encoder holds back several pictures at Main and High, whatever the delay count says.
		levels = levels[3:]
	}
	for _, level := range levels {
		if e.set(mx.kProfileLevel, level) == 0 {
			profiled = true
			break
		}
	}
	if !profiled {
		return errors.New("VideoToolbox does not take a high, main or baseline H.264 profile")
	}
	e.setNum(mx.kExpectedFPS, int32(e.p.FPS))
	e.setNum(mx.kMaxKeyInt, int32(2*e.p.FPS))
	d := mxFloat64(2)
	e.set(mx.kMaxKeyDur, d)
	mxCFRelease(d)
	if e.p.BitrateKbps > 0 {
		e.setNum(mx.kAvgBitRate, int32(e.p.BitrateKbps*1000))
		// The hardware encoder keeps to about 0.7 of the cap it is given, so the cap is set above the target.
		capBytes, one := mxInt32(int32(e.p.BitrateKbps*1000/8*14/10)), mxInt32(1)
		limits := mxArray(capBytes, one)
		e.set(mx.kDataRateLimits, limits)
		for _, o := range []uintptr{limits, capBytes, one} {
			mxCFRelease(o)
		}
	}
	return mxStatus("VTCompressionSessionPrepareToEncodeFrames", mx.vtPrepare(e.sess))
}

func (e *vtEncoder) setColour() {
	if e.p.Matrix == BT709 {
		e.prim, e.mat = mx.vPrim709, mx.vMat709
	} else {
		e.prim, e.mat = mx.vPrim601, mx.vMat601
	}
}

// tag writes the colour coding on a picture the session is given, the way the SPS will say it.
func (e *vtEncoder) tag(pb uintptr) {
	e.sc.call(mxFn.cvBufferSetAttachment, pb, mx.kPrimaries, e.prim, mxAttachPropagate)
	e.sc.call(mxFn.cvBufferSetAttachment, pb, mx.kTransfer, mx.vTransfer709, mxAttachPropagate)
	e.sc.call(mxFn.cvBufferSetAttachment, pb, mx.kMatrix, e.mat, mxAttachPropagate)
}

func (e *vtEncoder) Mode() string {
	if e.hw {
		return "videotoolbox"
	}
	return "videotoolbox-software"
}

func (e *vtEncoder) KeyFrame() { e.forceKey.Store(true) }

func (e *vtEncoder) EncodeBGRA(pix []byte, stride int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed.Load() {
		return errors.New("encoder is closed")
	}
	if e.inPool == 0 {
		return errors.New("encoder takes pictures from a capture")
	}
	rowBytes := e.p.Width * 4
	if stride < rowBytes || len(pix) < stride*(e.p.Height-1)+rowBytes {
		return fmt.Errorf("picture of %d bytes is too small for %dx%d", len(pix), e.p.Width, e.p.Height)
	}
	if e.inFlight.Load() >= mxMaxInFlight {
		return nil
	}
	e.pbIn, e.pbOut = 0, 0
	if st := int32(e.sc.call(mxFn.cvPoolCreateBuffer, 0, e.inPool, mxPtr(&e.pbIn))); st != 0 || e.pbIn == 0 {
		return mxStatus("CVPixelBufferPoolCreatePixelBuffer", st)
	}
	in := e.pbIn
	defer e.sc.call(mxFn.cfRelease, in)
	if st := int32(e.sc.call(mxFn.cvLockBase, in, 0)); st != 0 {
		return mxStatus("CVPixelBufferLockBaseAddress", st)
	}
	dstStride := int(e.sc.call(mxFn.cvBytesPerRow, in))
	dst := mxBytes(e.sc.call(mxFn.cvBaseAddress, in), dstStride*e.p.Height)
	for y := 0; y < e.p.Height; y++ {
		copy(dst[y*dstStride:y*dstStride+rowBytes], pix[y*stride:y*stride+rowBytes])
	}
	e.sc.call(mxFn.cvUnlockBase, in, 0)
	if st := int32(e.sc.call(mxFn.cvPoolCreateBuffer, 0, e.pool, mxPtr(&e.pbOut))); st != 0 || e.pbOut == 0 {
		return mxStatus("CVPixelBufferPoolCreatePixelBuffer", st)
	}
	out := e.pbOut
	defer e.sc.call(mxFn.cfRelease, out)
	e.tag(out)
	if st := int32(e.sc.call(mxFn.vtXferRun, e.xfer, in, out)); st != 0 {
		return mxStatus("VTPixelTransferSessionTransferImage", st)
	}
	return e.submit(out, e.pts())
}

// openTransfer makes the session that converts and scales pictures into the session's format with this encoder's matrix.
func (e *vtEncoder) openTransfer() error {
	if st := mx.vtXferCreate(0, &e.xfer); st != 0 {
		return mxStatus("VTPixelTransferSessionCreate", st)
	}
	mx.vtSetProperty(e.xfer, mx.kXferPrimaries, e.prim)
	mx.vtSetProperty(e.xfer, mx.kXferTransfer, mx.vTransfer709)
	mx.vtSetProperty(e.xfer, mx.kXferMatrix, e.mat)
	mx.vtSetProperty(e.xfer, mx.kXferRealTime, mx.cfTrue)
	return nil
}

// submit hands one picture of the session's format to the session; the caller keeps its reference to pb. mu is held.
func (e *vtEncoder) submit(pb uintptr, pts cmTime) error {
	e.tag(pb)
	props := uintptr(0)
	if e.forceKey.Swap(false) {
		props = e.props
	}
	e.inFlight.Add(1)
	e.stat.submitted()
	if st := mx.vtEncodeFrame(e.sess, pb, pts, e.duration, props, 0, &e.infoOut); st != 0 {
		e.inFlight.Add(-1)
		e.stat.rollback()
		return mxStatus("VTCompressionSessionEncodeFrame", st)
	}
	return nil
}

func (e *vtEncoder) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed.Swap(true) {
		return
	}
	if e.sess != 0 {
		mx.vtCompleteFrames(e.sess, cmTime{})
		mx.vtInvalidate(e.sess)
		mxCFRelease(e.sess)
		e.sess = 0
	}
	if e.inPool != 0 {
		mxCFRelease(e.inPool)
		e.inPool = 0
	}
	if e.pool != 0 {
		mxCFRelease(e.pool)
		e.pool = 0
	}
	if e.xfer != 0 {
		mx.vtXferInvalidate(e.xfer)
		mxCFRelease(e.xfer)
		e.xfer = 0
	}
	if e.props != 0 {
		mxCFRelease(e.props)
		e.props = 0
	}
	mxEncoders.Delete(e.handle)
}

// mxOutput is the session's output callback: (refcon, sourceFrameRefcon, status, infoFlags, sampleBuffer).
func mxOutput(refcon, _, status, _, sb uintptr) uintptr {
	v, ok := mxEncoders.Load(refcon)
	if !ok {
		return 0
	}
	e := v.(*vtEncoder)
	defer e.inFlight.Add(-1)
	e.stat.finished()
	if int32(status) == 0 && sb != 0 && !e.closed.Load() {
		e.emit(sb)
	}
	return 0
}

var annexStart = [4]byte{0, 0, 0, 1}

// emit turns one sample buffer into an Annex B access unit and delivers it.
func (e *vtEncoder) emit(sb uintptr) {
	key := true
	if arr := e.cc.call(mxFn.cmSampleAttachments, sb, 0); arr != 0 && e.cc.call(mxFn.cfArrayGetCount, arr) > 0 {
		d := e.cc.call(mxFn.cfArrayGetValueAtIdx, arr, 0)
		if v := e.cc.call(mxFn.cfDictionaryGetValue, d, mx.kNotSync); v != 0 && e.cc.call(mxFn.cfBooleanGetValue, v)&0xff != 0 {
			key = false
		}
	}
	au := e.scratch[:0]
	if key {
		fd := e.cc.call(mxFn.cmSampleFormatDesc, sb)
		if fd != 0 {
			for i := 0; ; i++ {
				if int32(e.cc.call(mxFn.cmH264ParamSet, fd, uintptr(i), mxPtr(&e.psPtr), mxPtr(&e.psSize), mxPtr(&e.psCount), mxPtr(&e.nalLen))) != 0 {
					break
				}
				au = append(au, annexStart[:]...)
				au = append(au, mxBytes(e.psPtr, e.psSize)...)
				if i+1 >= e.psCount {
					break
				}
			}
		}
	}
	bb := e.cc.call(mxFn.cmSampleDataBuffer, sb)
	if bb == 0 {
		return
	}
	if int32(e.cc.call(mxFn.cmBlockGetDataPointer, bb, 0, mxPtr(&e.cbLen), mxPtr(&e.cbTotal), mxPtr(&e.cbData))) != 0 {
		return
	}
	data := mxBytes(e.cbData, e.cbLen)
	if e.cbLen != e.cbTotal {
		if cap(e.bridge) < e.cbTotal {
			e.bridge = make([]byte, e.cbTotal)
		}
		data = e.bridge[:e.cbTotal]
		if int32(e.cc.call(mxFn.cmBlockCopyDataBytes, bb, 0, uintptr(e.cbTotal), mxPtr(&data[0]))) != 0 {
			return
		}
	}
	au = avccToAnnexB(au, data)
	e.scratch = au
	if len(au) > 0 {
		e.onAU(au)
	}
}

// mxNewPool makes a pool of IOSurface-backed pictures the session can take without a copy.
func mxNewPool(w, h int, format uint32) (uintptr, error) {
	wn, hn, fn := mxInt32(int32(w)), mxInt32(int32(h)), mxInt32(int32(format))
	iosurf := mxDict()
	attrs := mxDict(mx.kPBFormat, fn, mx.kPBWidth, wn, mx.kPBHeight, hn, mx.kPBIOSurface, iosurf)
	defer func() {
		for _, o := range []uintptr{wn, hn, fn, iosurf, attrs} {
			mxCFRelease(o)
		}
	}()
	var pool uintptr
	if st := mx.cvPoolCreate(0, 0, attrs, &pool); st != 0 {
		return 0, mxStatus("CVPixelBufferPoolCreate", st)
	}
	return pool, nil
}

func mxArray(v ...uintptr) uintptr {
	return mx.cfArrayCreate(0, &v[0], len(v), mx.cfArrCB)
}

// avccToAnnexB appends the length-prefixed NAL units in src to dst with start codes instead; a unit that runs past the end
// of src ends the conversion.
func avccToAnnexB(dst, src []byte) []byte {
	for len(src) >= 4 {
		n := int(src[0])<<24 | int(src[1])<<16 | int(src[2])<<8 | int(src[3])
		src = src[4:]
		if n <= 0 || n > len(src) {
			break
		}
		dst = append(dst, annexStart[:]...)
		dst = append(dst, src[:n]...)
		src = src[n:]
	}
	return dst
}
