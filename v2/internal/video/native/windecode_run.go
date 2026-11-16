//go:build windows

// The decoder goroutine's work: feed an access unit to the transform, pull the pictures it makes (NV12), turn the newest
// into RGBA at the size wanted and hand it over.
package native

import (
	"fmt"
	"unsafe"
)

const (
	outSample = iota // a picture came out
	outNone          // the transform wants more input
	outRetry         // the output type changed; ask again
	outFail
)

// winFrameTicks is one frame at 30 fps in 100 ns units; the decoder only needs the samples to be in order.
const winFrameTicks = 333333

func (d *winDecoder) handle(b *winAU) {
	if b.idr {
		d.skipping = false
		d.readSPS(b.data)
	} else if d.skipping {
		return
	}
	if d.m == nil && !d.open(d.ci, d.p.Width, d.p.Height) {
		d.skipping = true
		d.needKey.Store(true)
		return
	}
	d.feed(b.data)
}

// readSPS notes the colour description of a new sequence, and starts a hardware transform over when the size changed (the
// system decoder follows a change by itself).
func (d *winDecoder) readSPS(au []byte) {
	sps, ok := winFindSPS(au)
	if !ok {
		return
	}
	d.sps, d.haveSPS = sps, true
	if m := d.m; m != nil && m.cand.kind == candMFT && (m.w != sps.w || m.h != sps.h) {
		d.closeMFT()
		d.open(d.ci, sps.w, sps.h)
	}
}

func (d *winDecoder) feed(au []byte) {
	m := d.m
	hr := d.input(m, au)
	if hr == hrNotAccepting && !m.async {
		d.drain()
		hr = d.input(m, au)
	}
	if hr.failed() {
		d.fail(hr, "ProcessInput")
		return
	}
	m.fed++
	if m.async {
		m.credits--
	} else {
		d.drain()
	}
	if m.shown == 0 && m.fed >= 90 && d.ci+1 < len(d.cands) {
		d.advance()
	}
}

func (d *winDecoder) input(m *winMFT, au []byte) hresult {
	buf, err := mfCreateMemoryBuffer(len(au))
	if err != nil {
		return hrNoInterface
	}
	defer buf.release()
	p, max, _, err := buf.lock()
	if err != nil || max < len(au) {
		return hrNoInterface
	}
	copy(bytesAt(p, len(au)), au)
	buf.unlock()
	if buf.setLength(len(au)) != nil {
		return hrNoInterface
	}
	s, err := mfCreateSample()
	if err != nil {
		return hrNoInterface
	}
	defer s.release()
	if s.addBuffer(buf) != nil {
		return hrNoInterface
	}
	s.setSampleTime(d.ts)
	s.setSampleDuration(winFrameTicks)
	d.ts += winFrameTicks
	return m.t.processInput(s)
}

func (d *winDecoder) onEvent(t uint32) {
	m := d.m
	if m == nil {
		return
	}
	switch t {
	case meTransformNeedInput:
		m.credits++
	case meTransformHaveOutput:
		for i := 0; i < 4 && d.pullOutput() == outRetry; i++ {
		}
	}
}

func (d *winDecoder) drain() {
	for i := 0; i < 32; i++ {
		if r := d.pullOutput(); r == outNone || r == outFail {
			return
		}
	}
}

func (d *winDecoder) pullOutput() int {
	m := d.m
	if m == nil {
		return outFail
	}
	if !m.provides && m.outSample == (mfSample{}) {
		if d.negotiateOutput(m) != nil {
			return outNone
		}
	}
	m.out = mftOutputDataBuffer{}
	if !m.provides {
		if buf, err := m.outSample.buffer(); err == nil {
			buf.setLength(0)
			buf.release()
		}
		m.out.sample = uintptr(m.outSample.com)
	}
	m.status = 0
	hr := m.t.processOutput(&m.out, &m.status)
	sample, events := m.out.sample, m.out.events
	if events != 0 {
		com(events).release()
	}
	switch {
	case hr == hrNeedMoreInput:
		return outNone
	case hr == hrStreamChange || hr == hrTypeNotSet:
		if m.typeTries++; m.typeTries > 3 {
			d.fail(hr, "ProcessOutput")
			return outFail
		}
		if err := d.negotiateOutput(m); err != nil {
			d.fail(hr, "output type")
			return outFail
		}
		return outRetry
	case hr.failed():
		if m.provides && sample != 0 {
			com(sample).release()
		}
		d.fail(hr, "ProcessOutput")
		return outFail
	}
	m.typeTries = 0
	if sample == 0 {
		return outNone
	}
	if len(d.queue) < 2 {
		d.picture(m, mfSample{mfAttributes{com(sample)}})
	}
	if m.provides {
		com(sample).release()
	}
	return outSample
}

// negotiateOutput picks NV12 from the types the transform offers, and reads the geometry of the pictures it will make.
func (d *winDecoder) negotiateOutput(m *winMFT) error {
	for i := 0; ; i++ {
		mt, hr := m.t.outputAvailableType(i)
		if hr.failed() {
			return hr.err("GetOutputAvailableType")
		}
		sub, ok := mt.subtype()
		if !ok || sub != guidVideoNV12 {
			mt.release()
			continue
		}
		err := m.t.setOutputType(mt)
		mt.release()
		if err != nil {
			return err
		}
		break
	}
	cur, err := m.t.outputCurrentType()
	if err != nil {
		return err
	}
	defer cur.release()
	m.fw, m.fh, _ = cur.size()
	m.vw, m.vh, m.cx, m.cy = m.fw, m.fh, 0, 0
	area := &m.o.area
	blob := unsafe.Slice((*byte)(unsafe.Pointer(area)), int(unsafe.Sizeof(*area)))
	if n, ok, _ := cur.getBlob(&mfMTMinDisplayApert, blob); ok && n == len(blob) && area.width > 0 && area.height > 0 {
		m.vw, m.vh, m.cx, m.cy = int(area.width), int(area.height), int(area.offsetX), int(area.offsetY)
	}
	m.stride = 0
	if v, ok, _ := cur.getUINT32(&mfMTDefaultStride); ok && int32(v) > 0 {
		m.stride = int(int32(v))
	}
	if err := m.t.outputStreamInfo(&m.info); err != nil {
		return err
	}
	m.provides = m.info.flags&mftOutProvides != 0
	m.outSample.release()
	m.outSample = mfSample{}
	if !m.provides {
		size := max(int(m.info.size), nv12Size(m.fw, m.fh))
		buf, err := mfCreateMemoryBuffer(size)
		if err != nil {
			return err
		}
		defer buf.release()
		s, err := mfCreateSample()
		if err != nil {
			return err
		}
		if err := s.addBuffer(buf); err != nil {
			s.release()
			return err
		}
		m.outSample = s
	}
	return nil
}

// picture turns an NV12 sample into RGBA and delivers it. A panic from a bad picture is an error, not the end of the
// program.
func (d *winDecoder) picture(m *winMFT, s mfSample) {
	defer func() {
		if recover() != nil {
			d.fail(hrNotImpl, "picture")
		}
	}()
	matrix, full := winColour(d.sps, d.haveSPS, d.p, m.vw&^1)
	if d.pictureGPU(m, s, matrix, full) {
		return
	}
	o := &m.o
	if hr := s.call(41, uintptr(unsafe.Pointer(&o.buf))); hr.failed() { // ConvertToContiguousBuffer
		d.fail(hr, "ConvertToContiguousBuffer")
		return
	}
	buf := com(o.buf)
	defer buf.release()
	pitch, rows := m.stride, 0
	var base uintptr
	if hr := buf.call(0, iidIMF2DBuffer.p(), uintptr(unsafe.Pointer(&o.b2))); hr >= 0 {
		b2 := com(o.b2)
		defer b2.release()
		if hr := b2.call(3, uintptr(unsafe.Pointer(&o.scan)), uintptr(unsafe.Pointer(&o.pitch))); hr.failed() { // Lock2D
			d.fail(hr, "Lock2D")
			return
		}
		defer b2.call(4) // Unlock2D
		base, pitch = o.scan, int(o.pitch)
		o.contig = 0
		b2.call(7, uintptr(unsafe.Pointer(&o.contig))) // GetContiguousLength
		if pitch > 0 {
			rows = int(o.contig) * 2 / (3 * pitch)
		}
		if h := d.textureHeight(buf); h > 0 {
			rows = h
		}
	} else {
		if hr := buf.call(3, uintptr(unsafe.Pointer(&o.ptr)), uintptr(unsafe.Pointer(&o.max)), uintptr(unsafe.Pointer(&o.cur))); hr.failed() {
			d.fail(hr, "Lock")
			return
		}
		defer buf.call(4)
		base = o.ptr
		if pitch == 0 {
			pitch = m.fw
		}
		if pitch > 0 {
			rows = int(o.cur) * 2 / (3 * pitch)
		}
	}
	vw, vh, cx, cy := m.vw&^1, m.vh&^1, m.cx&^1, m.cy&^1
	if pitch <= 0 || vw < 2 || vh < 2 || rows < cy+vh || pitch < cx+vw {
		d.fail(hrNotImpl, fmt.Sprintf("picture geometry %dx%d in %dx%d", vw, vh, pitch, rows))
		return
	}
	mem := bytesAt(base, pitch*rows*3/2)
	y := mem[cy*pitch+cx : pitch*rows]
	uv := mem[pitch*rows+(cy/2)*pitch+cx:]
	m.shown++
	m.errs = 0
	d.convert(y, uv, pitch, vw, vh)
}

// textureHeight is the height of the Direct3D texture behind a buffer, 0 when it is not one: the chroma plane of a mapped
// NV12 texture starts after that many rows of the pitch, whatever the buffer says its length is.
func (d *winDecoder) textureHeight(buf com) int {
	o := &d.m.o
	if hr := buf.call(0, iidIMFDXGIBuffer.p(), uintptr(unsafe.Pointer(&o.b2))); hr.failed() {
		return 0
	}
	dxgi := com(o.b2)
	defer dxgi.release()
	if hr := dxgi.call(3, iidID3D11Texture2D.p(), uintptr(unsafe.Pointer(&o.tex))); hr.failed() { // GetResource
		return 0
	}
	tex := com(o.tex)
	defer tex.release()
	tex.call(10, uintptr(unsafe.Pointer(&o.desc))) // ID3D11Texture2D::GetDesc
	return int(o.desc[1])
}

func (d *winDecoder) convert(y, uv []byte, stride, vw, vh int) {
	ow, oh := winFit(vw, vh, d.p.Width, d.p.Height)
	d.rgba = grow(d.rgba, ow*oh*4)
	matrix, full := winColour(d.sps, d.haveSPS, d.p, vw)
	if ow == vw && oh == vh {
		nv12ToRGBA(d.rgba, y, stride, uv, stride, vw, vh, matrix, full)
	} else {
		d.sy, d.suv = grow(d.sy, ow*oh), grow(d.suv, ow*oh/2)
		d.scaler.plane(d.sy, ow, oh, y, stride, vw, vh, 1)
		d.scaler.plane(d.suv, ow/2, oh/2, uv, stride, vw/2, vh/2, 2)
		nv12ToRGBA(d.rgba, d.sy, ow, d.suv, ow, ow, oh, matrix, full)
	}
	d.onPicture(d.rgba, ow, oh)
}

func grow(b []byte, n int) []byte {
	if cap(b) < n {
		return make([]byte, n)
	}
	return b[:n]
}

// fail is called when the transform or a picture went wrong: the stream is dropped until the next key frame and a
// transform that never showed anything is given up for the next one.
func (d *winDecoder) fail(hr hresult, op string) {
	d.lastError = hr.err(op)
	d.skipping = true
	d.needKey.Store(true)
	m := d.m
	if m == nil {
		return
	}
	m.errs++
	if m.shown == 0 && m.errs >= 3 && d.ci+1 < len(d.cands) {
		d.advance()
		return
	}
	if !m.async {
		m.t.processMessage(mftMsgFlush, 0)
		m.credits = 1
	}
}

// advance moves on to the next decoder to try, at the size of the last one.
func (d *winDecoder) advance() {
	w, h := d.m.w, d.m.h
	d.closeMFT()
	d.open(d.ci+1, w, h)
	d.skipping = true
	d.needKey.Store(true)
}
