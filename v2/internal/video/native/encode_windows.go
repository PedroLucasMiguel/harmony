//go:build windows

// H.264 encoding through Media Foundation: the encoder transform of the graphics hardware (NVIDIA, AMD, Intel) or
// Microsoft's software encoder. Pictures come in as BGRA and are turned into NV12 straight into the transform's input
// buffers; the stream goes out as Annex B with the colour tagged in the SPS. A picture the encoder has no room for is
// dropped, never queued.
package native

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

const (
	encPoolSize      = 3
	encCloseWait     = 3 * time.Second
	encKeyFrameEvery = 2 * time.Second
	encStallPictures = 3
	encStallAfter    = 5 * time.Second
	hundredNs        = 10_000_000
)

var errEncoderClosed = errors.New("encoder closed")

// encPoolEntry is an input sample with its buffer. It can be reused when the transform no longer holds it.
type encPoolEntry struct {
	sample mfSample
	buf    mfBuffer
	queued atomic.Bool
}

// free reports whether nobody but the pool holds the sample: after one more reference it should count two.
func (p *encPoolEntry) free() bool {
	if p.queued.Load() {
		return false
	}
	n := p.sample.raw(1)
	p.sample.raw(2)
	return n == 2
}

type mftEncoder struct {
	w, h, fps, bitrate, matrix int
	size                       int
	backend                    string
	onAU                       func([]byte)
	onFail                     func(error)

	name      string
	profile   uint32
	mft       mfTransform
	act       mfActivate
	codec     codecAPI
	events    mfEventGenerator
	async     bool
	provides  bool
	pool      [encPoolSize]encPoolEntry
	outSample mfSample
	outBuf    mfBuffer
	out       mftOutputDataBuffer
	status    uint32
	setVar    variant
	keyVar    variant
	lock      struct {
		p        uintptr
		max, cur uint32
	}

	fix streamFixer

	credits  atomic.Int32
	accepted int
	outputs  atomic.Int64
	keyReq   atomic.Bool
	closed   atomic.Bool
	use      sync.Mutex // held by EncodeBGRA; the owner takes it to release the transform
	deliver  sync.Mutex // held while onAU runs, so that none runs after Close returns
	in       chan *encPoolEntry
	done     chan struct{}
	start    time.Time
	lastTS   int64
	lastKey  time.Time

	errMu sync.Mutex
	err   error
}

func newEncoder(p EncodeParams, onAU func([]byte)) (Encoder, error) {
	return newMFTEncoder(p, onAU, nil)
}

// newMFTEncoder is newEncoder with a callback for an encoder that fails after it started (the capture uses it).
func newMFTEncoder(p EncodeParams, onAU func([]byte), onFail func(error)) (*mftEncoder, error) {
	if p.Width <= 0 || p.Height <= 0 || p.Width%2 != 0 || p.Height%2 != 0 {
		return nil, fmt.Errorf("encoder size %dx%d must be even and not empty", p.Width, p.Height)
	}
	if p.FPS <= 0 || p.BitrateKbps <= 0 {
		return nil, fmt.Errorf("encoder rate %d fps and %d kbps must be positive", p.FPS, p.BitrateKbps)
	}
	e := &mftEncoder{
		w: p.Width, h: p.Height, fps: p.FPS, bitrate: p.BitrateKbps, matrix: p.Matrix, backend: p.Backend,
		size: nv12Size(p.Width, p.Height), onAU: onAU, onFail: onFail,
		in: make(chan *encPoolEntry, 1), done: make(chan struct{}),
	}
	e.fix.matrix = p.Matrix
	ready := make(chan error, 1)
	go e.run(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return e, nil
}

func (e *mftEncoder) Mode() string {
	kind := "software"
	if e.act.com != 0 {
		kind = "hardware"
	}
	return fmt.Sprintf("mediafoundation %s %s, h264 %s", kind, e.name, profileNames[e.profile])
}

func (e *mftEncoder) KeyFrame() { e.keyReq.Store(true) }

func (e *mftEncoder) fail(err error) {
	if e.closed.Load() {
		return
	}
	e.errMu.Lock()
	first := e.err == nil
	if first {
		e.err = err
	}
	e.errMu.Unlock()
	if first && e.onFail != nil {
		go e.onFail(err)
	}
}

func (e *mftEncoder) failure() error {
	e.errMu.Lock()
	defer e.errMu.Unlock()
	return e.err
}

// run is the encoder's own goroutine: it opens the transform, serves it until Close, and releases it.
func (e *mftEncoder) run(ready chan<- error) {
	defer close(e.done)
	end, err := comSession()
	if err != nil {
		ready <- err
		return
	}
	defer end()
	cands, err := encoderCandidates(e.backend)
	if err != nil {
		ready <- err
		return
	}
	defer releaseCandidates(cands)
	var last error
	for _, c := range cands {
		if last = e.open(c); last != nil {
			e.teardown()
			if e.backend != Auto {
				break
			}
			continue
		}
		e.start = time.Now()
		e.lastKey = e.start
		ready <- nil
		if e.async {
			e.serveAsync()
		} else {
			e.serveSync()
		}
		e.teardown()
		return
	}
	ready <- last
}

func (e *mftEncoder) Close() {
	e.use.Lock()
	if e.closed.Swap(true) {
		e.use.Unlock()
		return
	}
	switch {
	case e.mft.com == 0:
	case e.async:
		e.mft.processMessage(mftMsgEndOfStream, 0)
		e.mft.processMessage(mftMsgDrain, 0)
	default:
		close(e.in)
	}
	e.use.Unlock()
	select {
	case <-e.done:
	case <-time.After(encCloseWait):
	}
}

// teardown releases everything; it runs on the owner goroutine once nothing else uses the transform.
func (e *mftEncoder) teardown() {
	e.use.Lock()
	defer e.use.Unlock()
	if e.mft.com != 0 {
		e.mft.processMessage(mftMsgEndStream, 0)
	}
	for i := range e.pool {
		e.pool[i].sample.release()
		e.pool[i].buf.release()
	}
	e.outSample.release()
	e.outBuf.release()
	e.codec.release()
	e.events.release()
	e.mft.release()
	if e.act.com != 0 {
		e.act.shutdownObject()
	}
	e.mft, e.act, e.codec, e.events = mfTransform{}, mfActivate{}, codecAPI{}, mfEventGenerator{}
	e.outSample, e.outBuf = mfSample{}, mfBuffer{}
	e.pool = [encPoolSize]encPoolEntry{}
}

func (e *mftEncoder) EncodeBGRA(pix []byte, stride int) error {
	e.use.Lock()
	defer e.use.Unlock()
	if err := e.failure(); err != nil {
		return err
	}
	if e.closed.Load() || e.mft.com == 0 {
		return errEncoderClosed
	}
	if row := max(stride, -stride); row < e.w*4 || len(pix) < row*(e.h-1)+e.w*4 {
		return fmt.Errorf("picture of %d bytes does not hold %dx%d at stride %d", len(pix), e.w, e.h, stride)
	}
	if e.accepted >= encStallPictures && e.outputs.Load() == 0 && time.Since(e.start) > encStallAfter {
		err := errors.New("the encoder takes pictures and makes no stream")
		e.fail(err)
		return err
	}
	if e.async {
		if e.credits.Add(-1) < 0 {
			e.credits.Add(1)
			return nil
		}
	}
	entry := e.freeEntry()
	if entry == nil {
		if e.async {
			e.credits.Add(1)
		}
		return nil
	}
	if err := e.fill(entry, pix, stride); err != nil {
		if e.async {
			e.credits.Add(1)
		}
		return err
	}
	if time.Since(e.lastKey) >= encKeyFrameEvery {
		e.keyReq.Store(true)
	}
	if e.keyReq.Swap(false) && e.codec.com != 0 {
		e.codec.setUI4(&e.keyVar, &codecForceKeyFrame, 1)
		e.lastKey = time.Now()
	}
	if !e.async {
		entry.queued.Store(true)
		select {
		case e.in <- entry:
		default:
			entry.queued.Store(false)
		}
		return nil
	}
	switch hr := e.mft.processInput(entry.sample); {
	case hr == hrNotAccepting:
	case hr.failed():
		return hr.err("ProcessInput")
	default:
		e.accepted++
	}
	return nil
}

func (e *mftEncoder) freeEntry() *encPoolEntry {
	for i := range e.pool {
		if e.pool[i].free() {
			return &e.pool[i]
		}
	}
	return nil
}

// fill converts the picture into the entry's buffer and stamps it.
func (e *mftEncoder) fill(p *encPoolEntry, pix []byte, stride int) error {
	if hr := p.buf.call(3, uintptr(unsafe.Pointer(&e.lock.p)), uintptr(unsafe.Pointer(&e.lock.max)), uintptr(unsafe.Pointer(&e.lock.cur))); hr.failed() {
		return hr.err("IMFMediaBuffer::Lock")
	}
	if int(e.lock.max) < e.size {
		p.buf.unlock()
		return fmt.Errorf("input buffer of %d bytes is smaller than the %d of a picture", e.lock.max, e.size)
	}
	bgraToNV12(unsafe.Slice((*byte)(at(e.lock.p)), e.size), pix, e.w, e.h, stride, e.matrix)
	p.buf.unlock()
	if err := p.buf.setLength(e.size); err != nil {
		return err
	}
	ts := int64(time.Since(e.start)) / 100
	if ts <= e.lastTS {
		ts = e.lastTS + 1
	}
	e.lastTS = ts
	if err := p.sample.setSampleTime(ts); err != nil {
		return err
	}
	return p.sample.setSampleDuration(hundredNs / int64(e.fps))
}

// serveAsync handles the events of a hardware transform: it asks for pictures when it has room and hands out streams.
func (e *mftEncoder) serveAsync() {
	for {
		ev, hr := e.waitEvent()
		if hr.failed() {
			e.fail(hr.err("GetEvent"))
			return
		}
		typ := ev.eventType()
		var status hresult
		ev.call(35, uintptr(unsafe.Pointer(&status)))
		ev.release()
		if status.failed() {
			e.fail(status.err("encoder event"))
			return
		}
		switch typ {
		case meTransformNeedInput:
			e.credits.Add(1)
		case meTransformHaveOutput:
			if _, err := e.pullOutput(); err != nil {
				e.fail(err)
				return
			}
		case meTransformDrained:
			return
		}
	}
}

// waitEvent blocks until the transform has an event to report (IMFMediaEventGenerator::GetEvent with no flags).
func (e *mftEncoder) waitEvent() (mfEvent, hresult) {
	out := new(uintptr)
	hr := e.events.call(3, 0, uintptr(unsafe.Pointer(out)))
	return mfEvent{mfAttributes{com(*out)}}, hr
}

// serveSync runs a software transform: each picture is put in and the output taken out until it wants more.
func (e *mftEncoder) serveSync() {
	for entry := range e.in {
		hr := e.mft.processInput(entry.sample)
		entry.queued.Store(false)
		if hr.failed() && hr != hrNotAccepting {
			e.fail(hr.err("ProcessInput"))
			continue
		}
		for {
			more, err := e.pullOutput()
			if err != nil {
				e.fail(err)
				break
			}
			if !more {
				break
			}
		}
	}
}

// pullOutput takes one access unit out of the transform and delivers it; more is false when it wants more input.
func (e *mftEncoder) pullOutput() (more bool, err error) {
	e.out = mftOutputDataBuffer{}
	if !e.provides {
		e.out.sample = uintptr(e.outSample.com)
		e.outBuf.setLength(0)
	}
	hr := e.mft.processOutput(&e.out, &e.status)
	if e.out.events != 0 {
		com(e.out.events).release()
	}
	switch {
	case hr == hrNeedMoreInput:
		return false, nil
	case hr == hrStreamChange:
		t, hr := e.mft.outputAvailableType(0)
		if hr.failed() {
			return false, hr.err("GetOutputAvailableType")
		}
		defer t.release()
		return true, e.mft.setOutputType(t)
	case hr.failed():
		return false, hr.err("ProcessOutput")
	}
	if e.out.sample == 0 {
		return true, nil
	}
	sample := mfSample{mfAttributes{com(e.out.sample)}}
	if e.provides {
		defer sample.release()
	}
	buf, err := sample.buffer()
	if err != nil {
		return false, err
	}
	defer buf.release()
	p, _, n, err := buf.lock()
	if err != nil {
		return false, err
	}
	au := e.fix.fix(bytesAt(p, n))
	if len(au) > 0 {
		e.outputs.Add(1)
		e.deliver.Lock()
		if !e.closed.Load() {
			e.onAU(au)
		}
		e.deliver.Unlock()
	}
	buf.unlock()
	return true, nil
}
