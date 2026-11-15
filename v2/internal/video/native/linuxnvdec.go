//go:build linux

// H.264 decoding with NVDEC, the decoder in NVIDIA graphics cards, through the driver's libnvcuvid.so.1. The CUVID parser
// reads the Annex B stream and calls back (sequence, decode, display); the picture is scaled in the decoder to the size
// asked, read back as NV12 and converted to RGBA. Write copies the access unit into a small ring and returns; a goroutine
// of the decoder does the rest.
package native

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	// nvdecQueue is how many access units wait for the decoder; when it is behind, the next one is dropped and the
	// decoder asks for a key frame.
	nvdecQueue = 4
	// nvdecSessions is how many decoders can be open at once; the driver limits the sessions of a card well below this.
	nvdecSessions = 16
	// nvdecExtraSurfaces is how many decode surfaces the decoder keeps beyond the minimum the stream needs.
	nvdecExtraSurfaces = 2
	nvdecMaxPictures   = 8
)

// nvDecAPI is the driver's entry points and what the card can decode.
type nvDecAPI struct {
	getDecoderCaps, createDecoder, destroyDecoder, decodePicture           uintptr
	mapVideoFrame, unmapVideoFrame, createParser, parseData, destroyParser uintptr
	maxWidth, maxHeight, minWidth, minHeight                               int
}

func (s *nvSystem) probeDecode() error {
	lib, err := nvOpenLibrary(nvCuvidLib, "install the NVIDIA driver's decode library, the libnvidia-decode package of the driver")
	if err != nil {
		return err
	}
	f, err := nvSymbols(lib, nvCuvidLib, "cuvidGetDecoderCaps", "cuvidCreateDecoder", "cuvidDestroyDecoder", "cuvidDecodePicture",
		"cuvidMapVideoFrame64", "cuvidUnmapVideoFrame64", "cuvidCreateVideoParser", "cuvidParseVideoData", "cuvidDestroyVideoParser")
	if err != nil {
		return err
	}
	a := &s.dec
	a.getDecoderCaps, a.createDecoder, a.destroyDecoder, a.decodePicture = f[0], f[1], f[2], f[3]
	a.mapVideoFrame, a.unmapVideoFrame, a.createParser, a.parseData, a.destroyParser = f[4], f[5], f[6], f[7], f[8]

	if err := s.push(); err != nil {
		return err
	}
	defer s.pop()
	caps := &cuvidDecodeCaps{codecType: cuvidCodecH264, chromaFormat: cuvidChroma420}
	if st := nvResult(nvCall(a.getDecoderCaps, uintptr(unsafe.Pointer(caps)))); st != 0 {
		return s.cuError("cuvidGetDecoderCaps", st)
	}
	if caps.isSupported == 0 || caps.outputFormatMask&(1<<cuvidSurfaceNV12) == 0 {
		return errors.New("the graphics card's NVDEC does not decode 8 bit H.264")
	}
	a.maxWidth, a.maxHeight = int(caps.maxWidth), int(caps.maxHeight)
	a.minWidth, a.minHeight = int(caps.minWidth), int(caps.minHeight)
	return nil
}

var (
	nvdecSlots     [nvdecSessions]atomic.Pointer[nvDecoder]
	nvdecCbOnce    sync.Once
	nvdecCbSeq     uintptr
	nvdecCbDecode  uintptr
	nvdecCbDisplay uintptr
)

// nvdecCallbacks makes the three parser callbacks, once: a callback made by purego is never freed. The parser's user data is
// the 1 based number of the decoder's slot.
func nvdecCallbacks() (seq, decode, display uintptr) {
	nvdecCbOnce.Do(func() {
		nvdecCbSeq = purego.NewCallback(func(user, format uintptr) uintptr {
			if d := nvdecBySlot(user); d != nil {
				return d.onSequence(nvAt[cuvidVideoFormat](format))
			}
			return 0
		})
		nvdecCbDecode = purego.NewCallback(func(user, pic uintptr) uintptr {
			if d := nvdecBySlot(user); d != nil {
				return d.onDecode(pic)
			}
			return 0
		})
		nvdecCbDisplay = purego.NewCallback(func(user, info uintptr) uintptr {
			if d := nvdecBySlot(user); d != nil {
				return d.onDisplay(info)
			}
			return 0
		})
	})
	return nvdecCbSeq, nvdecCbDecode, nvdecCbDisplay
}

func nvdecBySlot(user uintptr) *nvDecoder {
	if user < 1 || user > nvdecSessions {
		return nil
	}
	return nvdecSlots[user-1].Load()
}

type nvDecoder struct {
	sys       *nvSystem
	api       *nvDecAPI
	params    DecodeParams
	onPicture func([]byte, int, int)
	slot      int

	mu      sync.Mutex
	cond    *sync.Cond
	ring    [nvdecQueue][]byte
	head    int
	count   int
	closed  bool
	waitKey bool
	done    chan struct{}

	// Used only by the decoder's goroutine, and by the parser's callbacks it makes.
	parser  uintptr
	pp      cuvidParserParams
	packet  cuvidSourcePacket
	decoder uintptr
	info    cuvidCreateInfo
	pics    [nvdecMaxPictures]cuvidDispInfo
	npics   int
	broken  bool
	frames  int64
	outW    int
	outH    int
	matrix  int
	full    bool
	nv12    []byte
	rgba    []byte
	proc    cuvidProcParams
	copy2D  cudaMemcpy2D
	devPtr  uint64
	pitch   uint32
}

func newNVDecoder(p DecodeParams, onPicture func([]byte, int, int)) (Decoder, error) {
	s := nvProbe()
	if s.decErr != nil {
		return nil, s.decErr
	}
	d := &nvDecoder{sys: s, api: &s.dec, params: p, onPicture: onPicture, waitKey: true, done: make(chan struct{})}
	d.cond = sync.NewCond(&d.mu)
	d.slot = -1
	for i := range nvdecSlots {
		if nvdecSlots[i].CompareAndSwap(nil, d) {
			d.slot = i
			break
		}
	}
	if d.slot < 0 {
		return nil, fmt.Errorf("NVDEC already has %d decoders open", nvdecSessions)
	}
	seq, decode, display := nvdecCallbacks()
	d.pp = cuvidParserParams{
		codecType:        cuvidCodecH264,
		maxNumDecodeSurf: 1,
		userData:         uintptr(d.slot + 1),
		sequenceCallback: seq,
		decodeCallback:   decode,
		displayCallback:  display,
	}
	if err := s.push(); err != nil {
		nvdecSlots[d.slot].Store(nil)
		return nil, err
	}
	st := nvResult(nvCall(d.api.createParser, uintptr(unsafe.Pointer(&d.parser)), uintptr(unsafe.Pointer(&d.pp))))
	s.pop()
	if st != 0 {
		nvdecSlots[d.slot].Store(nil)
		return nil, s.cuError("cuvidCreateVideoParser", st)
	}
	go d.run()
	return d, nil
}

func (d *nvDecoder) Mode() string { return "nvdec" }

// Write queues the access unit. It reports true while pictures cannot be shown until the next key frame: before the first
// one, after the decoder fell behind and after a failure.
func (d *nvDecoder) Write(au []byte) (needKeyframe bool) {
	if len(au) == 0 {
		return false
	}
	key := nvHasIDR(au)
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return false
	}
	if d.waitKey {
		if !key {
			return true
		}
		d.waitKey = false
	}
	if d.count == len(d.ring) {
		d.waitKey = true
		return true
	}
	i := (d.head + d.count) % len(d.ring)
	d.ring[i] = append(d.ring[i][:0], au...)
	d.count++
	d.cond.Signal()
	return false
}

var nvStartCode = []byte{0, 0, 1}

// nvHasIDR says whether the Annex B access unit has an IDR slice.
func nvHasIDR(au []byte) bool {
	for i := 0; ; {
		at := bytes.Index(au[i:], nvStartCode)
		if at < 0 || i+at+3 >= len(au) {
			return false
		}
		if au[i+at+3]&0x1f == 5 {
			return true
		}
		i += at + 3
	}
}

func (d *nvDecoder) needKeyframe() {
	d.mu.Lock()
	d.waitKey = true
	d.mu.Unlock()
}

func (d *nvDecoder) run() {
	defer close(d.done)
	for {
		d.mu.Lock()
		for d.count == 0 && !d.closed {
			d.cond.Wait()
		}
		if d.closed {
			d.mu.Unlock()
			return
		}
		au := d.ring[d.head]
		d.mu.Unlock()

		d.decode(au)

		d.mu.Lock()
		d.head = (d.head + 1) % len(d.ring)
		d.count--
		d.mu.Unlock()
	}
}

// decode gives one access unit to the parser, which calls back for what it finds, then hands over the pictures.
func (d *nvDecoder) decode(au []byte) {
	if err := d.sys.push(); err != nil {
		d.needKeyframe()
		return
	}
	defer d.sys.pop()
	d.npics, d.broken = 0, false
	d.frames++
	d.packet = cuvidSourcePacket{
		flags:       cuvidPktTimestamp | cuvidPktEndOfPicture,
		payloadSize: uint64(len(au)),
		payload:     uintptr(unsafe.Pointer(&au[0])),
		timestamp:   d.frames,
	}
	st := nvResult(nvCall(d.api.parseData, d.parser, uintptr(unsafe.Pointer(&d.packet))))
	if st != 0 || d.broken {
		d.needKeyframe()
	}
	for i := 0; i < d.npics && d.decoder != 0 && !d.broken; i++ {
		if !d.deliver(d.pics[i]) {
			d.needKeyframe()
			return
		}
	}
}

// onSequence is the parser telling that a stream of a new shape starts: make the decoder for it, scaling to the size asked.
// It returns how many decode surfaces the decoder has, or 0 to refuse the stream.
func (d *nvDecoder) onSequence(f *cuvidVideoFormat) uintptr {
	if f.codec != cuvidCodecH264 || f.chromaFormat != cuvidChroma420 || f.bitDepthLumaMinus8 != 0 || f.bitDepthChromaMinus8 != 0 {
		d.broken = true
		return 0
	}
	l, t, r, b := int(f.displayArea[0]), int(f.displayArea[1]), int(f.displayArea[2]), int(f.displayArea[3])
	if r <= l || b <= t {
		l, t, r, b = 0, 0, int(f.codedWidth), int(f.codedHeight)
	}
	sw, sh := (r-l)&^1, (b-t)&^1
	ow, oh := sw, sh
	if bw, bh := d.params.Width, d.params.Height; bw > 0 && bh > 0 && (sw > bw || sh > bh) {
		ow, oh = bw&^1, bh&^1
	}
	a := d.api
	if ow < 2 || oh < 2 || int(f.codedWidth) > a.maxWidth || int(f.codedHeight) > a.maxHeight ||
		int(f.codedWidth) < a.minWidth || int(f.codedHeight) < a.minHeight {
		d.broken = true
		return 0
	}
	surfaces := int(f.minNumDecodeSurfaces) + nvdecExtraSurfaces
	info := cuvidCreateInfo{
		width:             uint64(f.codedWidth),
		height:            uint64(f.codedHeight),
		numDecodeSurfaces: uint64(surfaces),
		codecType:         f.codec,
		chromaFormat:      f.chromaFormat,
		creationFlags:     cuvidCreatePreferCUVID,
		maxWidth:          uint64(f.codedWidth),
		maxHeight:         uint64(f.codedHeight),
		displayArea:       cuvidRect{int16(l), int16(t), int16(r), int16(b)},
		outputFormat:      cuvidSurfaceNV12,
		targetWidth:       uint64(ow),
		targetHeight:      uint64(oh),
		numOutputSurfaces: 1,
		targetRect:        cuvidRect{0, 0, int16(ow), int16(oh)},
	}
	d.setColour(f)
	if d.decoder != 0 && info == d.info {
		return uintptr(surfaces)
	}
	if d.decoder != 0 {
		nvCall(a.destroyDecoder, d.decoder)
		d.decoder = 0
	}
	d.info = info
	if st := nvResult(nvCall(a.createDecoder, uintptr(unsafe.Pointer(&d.decoder)), uintptr(unsafe.Pointer(&d.info)))); st != 0 {
		d.decoder = 0
		d.broken = true
		return 0
	}
	if ow != d.outW || oh != d.outH {
		d.outW, d.outH = ow, oh
		d.nv12 = make([]byte, nv12Size(ow, oh))
		d.rgba = make([]byte, ow*oh*4)
	}
	return uintptr(surfaces)
}

// setColour takes the colour coding from the stream when its VUI says one, and from the parameters otherwise.
func (d *nvDecoder) setColour(f *cuvidVideoFormat) {
	d.matrix, d.full = d.params.Matrix, d.params.Full
	switch f.matrix {
	case 1:
		d.matrix, d.full = BT709, f.fullRange()
	case 5, 6, 7:
		d.matrix, d.full = BT601, f.fullRange()
	}
}

// onDecode is the parser giving a picture to decode; the card does it.
func (d *nvDecoder) onDecode(pic uintptr) uintptr {
	if d.decoder == 0 {
		return 0
	}
	if st := nvResult(nvCall(d.api.decodePicture, d.decoder, pic)); st != 0 {
		d.broken = true
		return 0
	}
	return 1
}

// onDisplay is the parser saying which decoded picture to show next.
func (d *nvDecoder) onDisplay(info uintptr) uintptr {
	if info == 0 {
		return 1
	}
	if d.npics < len(d.pics) {
		d.pics[d.npics] = *nvAt[cuvidDispInfo](info)
		d.npics++
	}
	return 1
}

// deliver reads a decoded picture back from the card and hands it over as RGBA.
func (d *nvDecoder) deliver(pic cuvidDispInfo) bool {
	d.proc = cuvidProcParams{progressiveFrame: pic.progressiveFrame, topFieldFirst: pic.topFieldFirst}
	if st := nvResult(nvCall(d.api.mapVideoFrame, d.decoder, uintptr(pic.pictureIndex), uintptr(unsafe.Pointer(&d.devPtr)),
		uintptr(unsafe.Pointer(&d.pitch)), uintptr(unsafe.Pointer(&d.proc)))); st != 0 {
		return false
	}
	w, h := d.outW, d.outH
	ok := d.readPlane(0, w, h, 0) && d.readPlane(w*h, w, h/2, uint64(d.pitch)*uint64(h))
	nvCall(d.api.unmapVideoFrame, d.decoder, uintptr(d.devPtr))
	if !ok {
		return false
	}
	nv12ToRGBA(d.rgba, d.nv12[:w*h], w, d.nv12[w*h:], w, w, h, d.matrix, d.full)
	d.onPicture(d.rgba, w, h)
	return true
}

// readPlane copies rows rows of the mapped picture, from offset bytes after its start, to d.nv12 at dst.
func (d *nvDecoder) readPlane(dst, width, rows int, offset uint64) bool {
	d.copy2D = cudaMemcpy2D{
		srcMemoryType: cuMemoryDevice,
		srcDevice:     d.devPtr + offset,
		srcPitch:      uint64(d.pitch),
		dstMemoryType: cuMemoryHost,
		dstHost:       uintptr(unsafe.Pointer(&d.nv12[dst])),
		dstPitch:      uint64(width),
		widthInBytes:  uint64(width),
		height:        uint64(rows),
	}
	return nvResult(nvCall(d.sys.cuMemcpy2D, uintptr(unsafe.Pointer(&d.copy2D)))) == 0
}

func (d *nvDecoder) Close() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	d.cond.Broadcast()
	d.mu.Unlock()
	<-d.done
	if d.sys.push() == nil {
		nvCall(d.api.destroyParser, d.parser)
		if d.decoder != 0 {
			nvCall(d.api.destroyDecoder, d.decoder)
		}
		d.sys.pop()
	}
	nvdecSlots[d.slot].Store(nil)
}

func nvDecoderInfo() []BackendInfo {
	if s := nvProbe(); s.decErr == nil {
		return []BackendInfo{{ID: NVIDIA, Name: s.gpu + " (NVDEC)"}}
	}
	return nil
}
