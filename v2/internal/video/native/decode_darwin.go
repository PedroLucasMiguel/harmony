//go:build darwin

// H.264 decoding with VideoToolbox: a VTDecompressionSession makes RGBA pictures of the size asked, scaling and converting
// colour in the system's decoder, and a goroutine hands them over.
package native

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

const (
	// pictureQueue is how many decoded pictures wait for onPicture; when it is behind the oldest is dropped.
	pictureQueue = 2
	// askKeyEvery is how often a decoder that is waiting for a key frame says so again.
	askKeyEvery = time.Second
	// vtDecodeAsync is kVTDecodeFrame_EnableAsynchronousDecompression.
	vtDecodeAsync = 1
	// cmBlockAssureMemoryNow is kCMBlockBufferAssureMemoryNowFlag.
	cmBlockAssureMemoryNow = 1
	// vtInvalidSession is kVTInvalidSessionErr, what a session gives once the system took its decoder away.
	vtInvalidSession = -12903
)

var (
	mdecCallbackOnce sync.Once
	mdecCallbackPC   uintptr
	mdecNextID       atomic.Uintptr
	mdecDecoders     sync.Map
)

type macDecoder struct {
	api        *mdecAPI
	params     DecodeParams
	software   bool
	id         uintptr
	pixelType  uint32
	onPicture  func([]byte, int, int)
	queue      chan uintptr
	quit, done chan struct{}
	badAsync   atomic.Bool

	mu      sync.Mutex
	closed  bool
	nals    [][]byte
	avcc    []byte
	sig     []byte
	setPtrs [4]uintptr
	set     [8][]byte
	desc    uintptr
	session uintptr
	pic     mdecPicture
	waitKey bool
	lastAsk time.Time

	// scratch is memory the system reads or writes during a call. It lives in the decoder because a local whose address
	// is only passed as a number may be assumed unchanged by the compiler.
	scratch struct {
		ptrs, sizes  [8]uintptr
		keys, values [4]uintptr
		number       int32
		base, desc   uintptr
		session      uintptr
	}
	callback [2]uintptr
	blockOut uintptr
	sbufOut  uintptr
	flagsOut uint32
	sizeIn   uintptr
	picBuf   []uint32
}

func newDecoder(p DecodeParams, onPicture func([]byte, int, int)) (Decoder, error) {
	if p.Backend != Auto && p.Backend != VideoToolbox && p.Backend != Software {
		return nil, fmt.Errorf("the decoder %q is not on this system", p.Backend)
	}
	api, err := mdecLoad()
	if err != nil {
		return nil, err
	}
	mdecCallbackOnce.Do(func() { mdecCallbackPC = mdecNewCallback() })
	d := &macDecoder{api: api, params: p, software: p.Backend == Software, onPicture: onPicture, pixelType: mdecBGRA,
		queue: make(chan uintptr, pictureQueue), quit: make(chan struct{}), done: make(chan struct{}), waitKey: true}
	d.id = mdecNextID.Add(1)
	d.callback = [2]uintptr{mdecCallbackPC, d.id}
	mdecDecoders.Store(d.id, d)
	go d.serve()
	return d, nil
}

func (d *macDecoder) Mode() string {
	if d.software {
		return Software
	}
	return VideoToolbox
}

func (d *macDecoder) Write(au []byte) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return false
	}
	d.nals = mdecSplit(au, d.nals[:0])
	idr, slices, sets := false, 0, 0
	for _, n := range d.nals {
		switch n[0] & 0x1f {
		case nalIDR:
			idr = true
			slices++
		case nalSlice:
			slices++
		case nalSPS, nalPPS:
			if sets < len(d.set) {
				d.set[sets] = n
				sets++
			}
		}
	}
	if sets > 0 {
		d.newParameters(d.set[:sets])
	}
	if slices == 0 {
		return false
	}
	if d.desc == 0 || d.badAsync.Swap(false) {
		d.waitKey = true
	}
	if d.waitKey {
		if !idr || d.desc == 0 {
			return d.ask()
		}
		if d.session == 0 && !d.open() {
			return d.ask()
		}
		d.waitKey = false
	}
	if !d.decode() {
		d.waitKey = true
		return d.ask()
	}
	return false
}

func (d *macDecoder) ask() bool {
	if now := time.Now(); now.Sub(d.lastAsk) >= askKeyEvery {
		d.lastAsk = now
		return true
	}
	return false
}

// newParameters switches to the parameter sets in a unit when they differ from the ones in use: the session is kept when
// the system can still decode with the new ones and replaced otherwise.
func (d *macDecoder) newParameters(sets [][]byte) {
	n := 0
	for _, s := range sets {
		n += len(s) + 1
	}
	sig := make([]byte, 0, n)
	for _, s := range sets {
		sig = append(append(sig, byte(len(s)>>8)), s...)
	}
	if string(sig) == string(d.sig) {
		return
	}
	var pic mdecPicture
	var have bool
	for _, s := range sets {
		if s[0]&0x1f == nalSPS {
			pic, have = mdecParseSPS(s)
			break
		}
	}
	if !have {
		return
	}
	desc := d.describe(sets, pic)
	if desc == 0 {
		return
	}
	d.sig = sig
	d.pic = pic
	if d.session != 0 && mdecCall(d.api.vtCanAccept, d.session, desc)&0xff == 0 {
		d.closeSession()
		d.waitKey = true
	}
	d.api.release(d.desc)
	d.desc = desc
}

// describe is a format description made from the parameter sets, tagged with how the colours are coded: the stream's
// own tag, else what the caller said, else the way Chromium reads an untagged stream.
func (d *macDecoder) describe(sets [][]byte, pic mdecPicture) uintptr {
	a, sc := d.api, &d.scratch
	for i, s := range sets {
		sc.ptrs[i], sc.sizes[i] = mdecPtr(&s[0]), uintptr(len(s))
	}
	sc.base = 0
	if mdecStatus(mdecCall(a.cmFmtFromH264, 0, uintptr(len(sets)), mdecPtr(&sc.ptrs[0]), mdecPtr(&sc.sizes[0]), 4, mdecPtr(&sc.base))) != 0 || sc.base == 0 {
		return 0
	}
	base := sc.base
	defer a.release(base)
	baseExt := mdecCall(a.cmFmtExtensions, base)
	if baseExt == 0 {
		return 0
	}
	ext := mdecCall(a.cfDictMutableCopy, 0, 0, baseExt)
	if ext == 0 {
		return 0
	}
	defer a.release(ext)
	matrix, full := pic.matrix, pic.full
	if matrix == 2 || matrix == 0 {
		matrix = d.params.Matrix
		if !pic.tagged {
			full = d.params.Full
		}
	}
	if matrix == 0 || matrix == 2 {
		matrix = BT601
		if pic.w > 640 {
			matrix = BT709
		}
	}
	m := a.matrix601
	switch matrix {
	case 1:
		m = a.matrix709
	case 7:
		m = a.matrix240
	case 9, 10:
		m = a.matrix2020
	}
	f := a.boolFalse
	if full {
		f = a.boolTrue
	}
	mdecCall(a.cfDictSet, ext, a.extMatrix, m)
	mdecCall(a.cfDictSet, ext, a.extFull, f)
	mdecCall(a.cfDictSet, ext, a.extPrimaries, a.primaries709)
	mdecCall(a.cfDictSet, ext, a.extTransfer, a.transfer709)
	sc.desc = 0
	if mdecStatus(mdecCall(a.cmFmtCreate, 0, mdecAvc1, uintptr(pic.w), uintptr(pic.h), ext, mdecPtr(&sc.desc))) != 0 {
		return 0
	}
	return sc.desc
}

func (d *macDecoder) number(v int32) uintptr {
	d.scratch.number = v
	return mdecCall(d.api.cfNumberCreate, 0, mdecNumberSInt32, mdecPtr(&d.scratch.number))
}

func (d *macDecoder) dict(keys, values []uintptr) uintptr {
	sc := &d.scratch
	copy(sc.keys[:], keys)
	copy(sc.values[:], values)
	return mdecCall(d.api.cfDictCreate, 0, mdecPtr(&sc.keys[0]), mdecPtr(&sc.values[0]), uintptr(len(keys)), d.api.keyCallbacks, d.api.valueCallbacks)
}

// open starts the decompression session; pictures are made at the box size, or at the stream's when that is smaller.
func (d *macDecoder) open() bool {
	a := d.api
	w, h := d.params.Width, d.params.Height
	if w <= 0 || h <= 0 || (d.pic.w <= w && d.pic.h <= h) {
		w, h = d.pic.w, d.pic.h
	}
	nw, nh, nf := d.number(int32(w)), d.number(int32(h)), d.number(int32(d.pixelType))
	keys := []uintptr{a.pixelFormatKey, a.pixelWidthKey, a.pixelHeightKey}
	attrs := d.dict(keys, []uintptr{nf, nw, nh})
	a.release(nw)
	a.release(nh)
	a.release(nf)
	var spec uintptr
	if d.software {
		spec = d.dict([]uintptr{a.specHardware}, []uintptr{a.boolFalse})
	}
	d.scratch.session = 0
	st := mdecStatus(mdecCall(a.vtCreate, 0, d.desc, spec, attrs, mdecPtr(&d.callback[0]), mdecPtr(&d.scratch.session)))
	session := d.scratch.session
	a.release(attrs)
	a.release(spec)
	if st != 0 || session == 0 {
		return false
	}
	mdecCall(a.vtSetProperty, session, a.vtRealTime, a.boolTrue)
	d.session = session
	return true
}

func (d *macDecoder) closeSession() {
	if d.session != 0 {
		mdecCall(d.api.vtWait, d.session)
		mdecCall(d.api.vtInvalidate, d.session)
		d.api.release(d.session)
		d.session = 0
	}
}

// decode hands the slices in d.nals to the session as one length-prefixed sample.
func (d *macDecoder) decode() bool {
	a := d.api
	d.avcc = d.avcc[:0]
	for _, n := range d.nals {
		if t := n[0] & 0x1f; t != nalSlice && t != nalIDR {
			continue
		}
		l := len(n)
		d.avcc = append(d.avcc, byte(l>>24), byte(l>>16), byte(l>>8), byte(l))
		d.avcc = append(d.avcc, n...)
	}
	size := uintptr(len(d.avcc))
	if mdecStatus(mdecCall(a.cmBlockCreate, 0, 0, size, 0, 0, 0, size, cmBlockAssureMemoryNow, mdecPtr(&d.blockOut))) != 0 {
		return false
	}
	defer a.release(d.blockOut)
	if mdecStatus(mdecCall(a.cmBlockReplace, mdecPtr(&d.avcc[0]), d.blockOut, 0, size)) != 0 {
		return false
	}
	d.sizeIn = size
	if mdecStatus(mdecCall(a.cmSbufReady, 0, d.blockOut, d.desc, 1, 0, 0, 1, mdecPtr(&d.sizeIn), mdecPtr(&d.sbufOut))) != 0 {
		return false
	}
	defer a.release(d.sbufOut)
	st := mdecStatus(mdecCall(a.vtDecode, d.session, d.sbufOut, vtDecodeAsync, 0, mdecPtr(&d.flagsOut)))
	if st == vtInvalidSession {
		d.closeSession()
	}
	return st == 0
}

// picture is called by VideoToolbox on its own thread with a decoded picture.
func (d *macDecoder) picture(status int32, buf uintptr) {
	if status != 0 {
		d.badAsync.Store(true)
		return
	}
	if buf == 0 {
		return
	}
	mdecCall(d.api.cfRetain, buf)
	select {
	case d.queue <- buf:
		return
	default:
	}
	select {
	case old := <-d.queue:
		d.api.release(old)
	default:
	}
	select {
	case d.queue <- buf:
	default:
		d.api.release(buf)
	}
}

func (d *macDecoder) serve() {
	defer close(d.done)
	for {
		select {
		case buf := <-d.queue:
			d.deliver(buf)
		case <-d.quit:
			for {
				select {
				case buf := <-d.queue:
					d.api.release(buf)
				default:
					return
				}
			}
		}
	}
}

func (d *macDecoder) deliver(buf uintptr) {
	a := d.api
	defer a.release(buf)
	if mdecStatus(mdecCall(a.cvLock, buf, 1)) != 0 {
		return
	}
	defer mdecCall(a.cvUnlock, buf, 1)
	w, h := int(mdecCall(a.cvWidth, buf)), int(mdecCall(a.cvHeight, buf))
	stride := int(mdecCall(a.cvBytesPerRow, buf))
	base := mdecCall(a.cvBase, buf)
	if base == 0 || w <= 0 || h <= 0 || stride < w*4 || stride%4 != 0 {
		return
	}
	if len(d.picBuf) != w*h {
		d.picBuf = make([]uint32, w*h)
	}
	src := mdecWords(base, stride/4*h)
	dst := d.picBuf
	for y := 0; y < h; y++ {
		row, out := src[y*(stride/4):y*(stride/4)+w], dst[y*w:(y+1)*w]
		for x, v := range row {
			out[x] = v&0xff00ff00 | v>>16&0xff | v&0xff<<16
		}
	}
	d.onPicture(unsafe.Slice((*byte)(unsafe.Pointer(&dst[0])), w*h*4), w, h)
}

func (d *macDecoder) Close() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	d.closeSession()
	d.api.release(d.desc)
	d.desc = 0
	d.mu.Unlock()
	mdecDecoders.Delete(d.id)
	close(d.quit)
	<-d.done
}
