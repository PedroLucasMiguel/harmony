//go:build linux

package native

// The H.264 encoder on VA-API (AMD through Mesa, Intel through the media driver): pictures go into NV12 surfaces, the
// graphics hardware encodes them, and the encoder's goroutine turns what the driver wrote into access units with the
// client's own parameter sets in front of every key frame. Constrained baseline or main, no B frames, one reference.

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"
)

const (
	vaEncSlots    = 2
	vaMaxIDRGap   = 250
	vaFirstQP     = 26
	vaMinQP       = 10
	vaMaxQP       = 51
	vaCodedBytesM = 400 // coded buffer bytes per 16x16 macroblock, as in libva's own encoder sample
)

type vaEncSlot struct {
	input vaSurfaceID
	coded vaBufferID
	idr   bool
}

type vaEncoder struct {
	d       *vaDisplay
	cfg     h264Config
	p       EncodeParams
	codedW  int
	codedH  int
	sps     []byte
	pps     []byte
	packed  uint32
	cbr     bool
	config  vaConfigID
	context vaContextID
	input   []vaSurfaceID
	recon   [2]vaSurfaceID
	image   vaImage
	derive  bool
	onAU    func([]byte)

	free chan *vaEncSlot
	done chan *vaEncSlot
	wg   sync.WaitGroup

	keyframe atomic.Bool
	broken   atomic.Bool

	mu        sync.Mutex
	closed    bool
	nv12      []byte
	frameNum  int
	sinceIDR  int
	idrID     int
	reconNext int
	started   bool
	seq       vaEncSequenceParameterBufferH264
	pic       vaEncPictureParameterBufferH264
	slice     vaEncSliceParameterBufferH264
	rc        vaEncMiscRateControl
	hrd       vaEncMiscHRD
	fps       vaEncMiscFrameRate
	au        []byte
	bufs      []vaBufferID
	ends      []int
	bufErr    error
	header    vaEncPackedHeaderParameterBuffer
	dimg      vaImage
}

// vaEncChoice is a VA-API profile and the profile_idc the stream says it is.
type vaEncChoice struct {
	profile int32
	idc     byte
}

// vaEncChoices are tried in the order the Electron client prefers H.264 profiles: High, Main, constrained baseline.
var vaEncChoices = []vaEncChoice{{vaProfileH264High, h264ProfileHigh}, {vaProfileH264Main, h264ProfileMain}, {vaProfileH264ConstrainedBaseline, h264ProfileBaseline}}

func newVAEncoder(p EncodeParams, onAU func([]byte), vendor uint32) (Encoder, error) {
	if p.Width < 16 || p.Height < 16 || p.Width%2 != 0 || p.Height%2 != 0 || p.FPS <= 0 || p.BitrateKbps <= 0 {
		return nil, fmt.Errorf("VA-API encoder: bad picture parameters %dx%d at %d fps, %d kbps", p.Width, p.Height, p.FPS, p.BitrateKbps)
	}
	var firstErr error
	for _, c := range vaEncChoices {
		d, err := openVADisplay(vendor, c.profile, vaEntrypointEncSlice, vaEntrypointEncSliceLP)
		if err != nil {
			firstErr = cmpErr(firstErr, err)
			continue
		}
		e, err := startVAEncoder(d, c, p, onAU)
		if err == nil {
			return e, nil
		}
		d.Close()
		firstErr = cmpErr(firstErr, err)
	}
	return nil, firstErr
}

// cmpErr keeps the error of the first choice, which is the one the user can act on.
func cmpErr(first, next error) error {
	if first != nil {
		return first
	}
	return next
}

func startVAEncoder(d *vaDisplay, c vaEncChoice, p EncodeParams, onAU func([]byte)) (*vaEncoder, error) {
	e := &vaEncoder{d: d, p: p, onAU: onAU, cfg: newH264Config(p.Width, p.Height, p.FPS, p.BitrateKbps, p.Matrix, c.idc)}
	e.codedW, e.codedH = e.cfg.mbW()*16, e.cfg.mbH()*16
	if err := e.createConfig(c.profile); err != nil {
		return nil, err
	}
	if err := e.createSurfaces(); err != nil {
		e.destroy()
		return nil, err
	}
	e.sps = e.cfg.appendSPS(nil)
	e.pps = e.cfg.appendPPS(nil)
	e.nv12 = make([]byte, nv12Size(p.Width, p.Height))
	e.au = make([]byte, 0, 1<<18)
	e.bufs, e.ends = make([]vaBufferID, 0, 12), make([]int, 0, 6)
	e.free = make(chan *vaEncSlot, vaEncSlots)
	e.done = make(chan *vaEncSlot, vaEncSlots)
	for i := range vaEncSlots {
		s := &vaEncSlot{input: e.input[i]}
		var err error
		if s.coded, err = d.createBuffer(e.context, vaEncCodedBufferType, e.codedW*e.codedH*vaCodedBytesM/256, 1, nil); err != nil {
			e.destroy()
			return nil, err
		}
		e.free <- s
	}
	e.buildFixedParams()
	e.wg.Add(1)
	go e.run()
	return e, nil
}

func (e *vaEncoder) createConfig(profile int32) error {
	ep := e.d.Entrypoint
	attribs := []vaConfigAttrib{{Type: vaConfigAttribRTFormat}, {Type: vaConfigAttribRateControl}, {Type: vaConfigAttribEncPackedHeaders}}
	if err := e.d.configAttributes(profile, ep, attribs); err != nil {
		return err
	}
	if attribs[0].Value&vaRTFormatYUV420 == 0 || attribs[0].Value == vaAttribNotSupported {
		return errors.New("VA-API encoder: the driver cannot encode 4:2:0 pictures")
	}
	rc := attribs[1].Value
	switch {
	case rc != vaAttribNotSupported && rc&vaRCCBR != 0:
		e.cbr = true
		rc = vaRCCBR
	case rc != vaAttribNotSupported && rc&vaRCVBR != 0:
		rc = vaRCVBR
	default:
		return fmt.Errorf("VA-API encoder: the %s driver has no bit rate control for H.264", e.d.Vendor)
	}
	if attribs[2].Value != vaAttribNotSupported {
		e.packed = attribs[2].Value & (vaEncPackedHeaderSequence | vaEncPackedHeaderPicture)
	}
	cfgAttribs := []vaConfigAttrib{{Type: vaConfigAttribRTFormat, Value: vaRTFormatYUV420}, {Type: vaConfigAttribRateControl, Value: rc}}
	if e.packed != 0 {
		cfgAttribs = append(cfgAttribs, vaConfigAttrib{Type: vaConfigAttribEncPackedHeaders, Value: e.packed})
	}
	id, err := e.d.createConfig(profile, ep, cfgAttribs)
	e.config = id
	return err
}

func (e *vaEncoder) createSurfaces() error {
	n := vaEncSlots + len(e.recon)
	ids, err := e.d.createSurfaces(vaRTFormatYUV420, e.codedW, e.codedH, n, vaSurfaceUsageEncoder)
	if err != nil {
		if ids, err = e.d.createSurfaces(vaRTFormatYUV420, e.codedW, e.codedH, n, 0); err != nil {
			return err
		}
	}
	e.input = ids[:vaEncSlots]
	copy(e.recon[:], ids[vaEncSlots:])
	if e.context, err = e.d.createContext(e.config, e.codedW, e.codedH, ids); err != nil {
		e.d.destroySurfaces(ids)
		e.input = nil
		return err
	}
	return e.prepareUpload()
}

// prepareUpload picks how pictures get into a surface: straight into its memory when the driver shows it as linear NV12,
// through an image and vaPutImage when it does not.
func (e *vaEncoder) prepareUpload() error {
	var img vaImage
	if e.d.deriveImage(e.input[0], &img) == nil {
		ok := img.Format.Fourcc == vaFourccNV12 && img.NumPlanes == 2
		e.d.destroyImage(img.ImageID)
		if ok {
			e.derive = true
			return nil
		}
	}
	format, ok := e.d.imageFormat(vaFourccNV12)
	if !ok {
		return errors.New("VA-API encoder: the driver has no NV12 image format")
	}
	return e.d.createImage(&format, e.codedW, e.codedH, &e.image)
}

func (e *vaEncoder) buildFixedParams() {
	c := &e.cfg
	s := &e.seq
	s.LevelIdc = c.Level
	s.IntraPeriod = uint32(e.p.FPS * 2)
	s.IntraIdrPeriod = uint32(e.p.FPS * 2)
	s.IpPeriod = 1
	s.BitsPerSecond = uint32(e.p.BitrateKbps * 1000)
	s.MaxNumRefFrames = 1
	s.PictureWidthInMbs = uint16(c.mbW())
	s.PictureHeightInMbs = uint16(c.mbH())
	s.SeqFields = 1<<vaEncSeqChromaFormatIdc | 1<<vaEncSeqFrameMbsOnly | 1<<vaEncSeqDirect8x8Inference |
		uint32(c.Log2MaxFrameNum-4)<<vaEncSeqLog2MaxFrameNum | uint32(c.POCType)<<vaEncSeqPocType |
		uint32(c.Log2MaxPOCLsb-4)<<vaEncSeqLog2MaxPocLsb
	if cropX, cropY := (c.mbW()*16-c.W)/2, (c.mbH()*16-c.H)/2; cropX|cropY != 0 {
		s.FrameCroppingFlag = 1
		s.FrameCropRightOffset = uint32(cropX)
		s.FrameCropBottomOffset = uint32(cropY)
	}
	s.VuiParametersPresentFlag = 1
	s.VuiFields = 1<<vaEncVuiAspectRatioPresent | 1<<vaEncVuiTimingInfoPresent | 1<<vaEncVuiBitstreamRestrict |
		uint32(c.Log2MaxMV)<<vaEncVuiLog2MaxMvLenH | uint32(c.Log2MaxMV)<<vaEncVuiLog2MaxMvLenV | 1<<vaEncVuiMvOverPicBoundaries
	s.AspectRatioIdc = 1
	s.NumUnitsInTick = 1
	s.TimeScale = uint32(2 * e.p.FPS)

	bps := uint32(e.p.BitrateKbps * 1000)
	e.rc.Type = vaEncMiscParameterTypeRateControl
	e.rc.BitsPerSecond, e.rc.TargetPercentage = bps, 100
	if !e.cbr {
		e.rc.BitsPerSecond, e.rc.TargetPercentage = bps*5/4, 80
	}
	e.rc.WindowSize = 500
	e.rc.InitialQp, e.rc.MinQp, e.rc.MaxQp = vaFirstQP, vaMinQP, vaMaxQP
	e.hrd.Type = vaEncMiscParameterTypeHRD
	e.hrd.BufferSize = bps / 2
	e.hrd.InitialBufferFullness = e.hrd.BufferSize * 3 / 4
	e.fps.Type = vaEncMiscParameterTypeFrameRate
	e.fps.Framerate = uint32(e.p.FPS)

	e.pic.CodedBuf = vaInvalidID
	e.pic.PicInitQp = vaFirstQP
}

func (e *vaEncoder) Mode() string { return "vaapi" }

func (e *vaEncoder) KeyFrame() { e.keyframe.Store(true) }

func (e *vaEncoder) EncodeBGRA(pix []byte, stride int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errors.New("VA-API encoder is closed")
	}
	if len(pix) < stride*(e.p.Height-1)+e.p.Width*4 {
		return errors.New("VA-API encoder: picture is smaller than the encoder's size")
	}
	slot := e.takeSlot()
	if slot == nil {
		return nil
	}
	bgraToNV12(e.nv12, pix, e.p.Width, e.p.Height, stride, e.p.Matrix)
	return e.submit(slot)
}

// EncodeNV12 takes a tightly packed picture already in the stream's colour coding.
func (e *vaEncoder) EncodeNV12(nv12 []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errors.New("VA-API encoder is closed")
	}
	if len(nv12) < len(e.nv12) {
		return errors.New("VA-API encoder: picture is smaller than the encoder's size")
	}
	slot := e.takeSlot()
	if slot == nil {
		return nil
	}
	copy(e.nv12, nv12)
	return e.submit(slot)
}

// takeSlot is nil when the hardware still has the last pictures: this one is dropped, never queued.
func (e *vaEncoder) takeSlot() *vaEncSlot {
	select {
	case s := <-e.free:
		return s
	default:
		return nil
	}
}

func (e *vaEncoder) upload(surface vaSurfaceID) error {
	img := &e.image
	if e.derive {
		img = &e.dimg
		if err := e.d.deriveImage(surface, img); err != nil {
			return err
		}
		defer e.d.destroyImage(img.ImageID)
	}
	p, err := e.d.mapBuffer(img.Buf)
	if err != nil {
		return err
	}
	data := unsafe.Slice((*byte)(p), img.DataSize)
	ok := copyNV12Padded(data, int(img.Offsets[0]), int(img.Pitches[0]), int(img.Offsets[1]), int(img.Pitches[1]), e.nv12, e.p.Width, e.p.Height, e.codedW, e.codedH)
	e.d.unmapBuffer(img.Buf)
	if !ok {
		return errors.New("VA-API encoder: the driver's image layout does not fit the picture")
	}
	if !e.derive {
		return e.d.putImage(surface, img.ImageID, e.codedW, e.codedH)
	}
	return nil
}

func (e *vaEncoder) submit(slot *vaEncSlot) error {
	if err := e.upload(slot.input); err != nil {
		e.free <- slot
		return err
	}
	wanted, lost := e.keyframe.Swap(false), e.broken.Swap(false)
	idr := !e.started || wanted || lost || e.sinceIDR >= e.p.FPS*2 || e.sinceIDR >= vaMaxIDRGap
	if idr {
		e.frameNum, e.sinceIDR = 0, 0
		e.idrID++
	}
	cur := e.recon[e.reconNext]
	prev := e.recon[1-e.reconNext]
	poc := int32(2 * e.sinceIDR)
	e.fillPicture(idr, cur, prev, poc, slot.coded)
	e.fillSlice(idr, prev, poc)

	e.bufs, e.ends, e.bufErr = e.bufs[:0], e.ends[:0], nil
	if idr {
		e.add(vaEncSequenceParameterBufferType, unsafe.Sizeof(e.seq), unsafe.Pointer(&e.seq))
		e.endGroup()
	}
	if !e.started {
		e.add(vaEncMiscParameterBufferType, unsafe.Sizeof(e.rc), unsafe.Pointer(&e.rc))
		e.add(vaEncMiscParameterBufferType, unsafe.Sizeof(e.hrd), unsafe.Pointer(&e.hrd))
		e.add(vaEncMiscParameterBufferType, unsafe.Sizeof(e.fps), unsafe.Pointer(&e.fps))
		e.endGroup()
	}
	e.add(vaEncPictureParameterBufferType, unsafe.Sizeof(e.pic), unsafe.Pointer(&e.pic))
	e.endGroup()
	if idr {
		if e.packed&vaEncPackedHeaderSequence != 0 {
			e.addPackedHeader(vaEncPackedHeaderSequence, e.sps)
		}
		if e.packed&vaEncPackedHeaderPicture != 0 {
			e.addPackedHeader(vaEncPackedHeaderPicture, e.pps)
		}
	}
	e.add(vaEncSliceParameterBufferType, unsafe.Sizeof(e.slice), unsafe.Pointer(&e.slice))
	e.endGroup()

	if err := e.render(slot); err != nil {
		e.broken.Store(true)
		e.free <- slot
		return err
	}
	e.started = true
	e.reconNext = 1 - e.reconNext
	e.frameNum = (e.frameNum + 1) % (1 << e.cfg.Log2MaxFrameNum)
	e.sinceIDR++
	slot.idr = idr
	e.done <- slot
	return nil
}

func (e *vaEncoder) add(typ int32, size uintptr, data unsafe.Pointer) {
	id, err := e.d.createBuffer(e.context, typ, int(size), 1, data)
	if err != nil {
		e.bufErr = err
		return
	}
	e.bufs = append(e.bufs, id)
}

// endGroup closes the buffers added since the last group: each group is one vaRenderPicture call.
func (e *vaEncoder) endGroup() { e.ends = append(e.ends, len(e.bufs)) }

func (e *vaEncoder) addPackedHeader(typ uint32, nal []byte) {
	e.header = vaEncPackedHeaderParameterBuffer{Type: typ, BitLength: uint32(len(nal) * 8), HasEmulationBytes: 1}
	e.add(vaEncPackedHeaderParameterBufferType, unsafe.Sizeof(e.header), unsafe.Pointer(&e.header))
	e.add(vaEncPackedHeaderDataBufferType, uintptr(len(nal)), unsafe.Pointer(&nal[0]))
	e.endGroup()
}

// render sends the buffers and starts the encode. Buffers that were sent belong to libva afterwards; the ones that were
// not are destroyed here.
func (e *vaEncoder) render(slot *vaEncSlot) error {
	if e.bufErr != nil {
		e.destroyBufs(0)
		return e.bufErr
	}
	if err := e.d.beginPicture(e.context, slot.input); err != nil {
		e.destroyBufs(0)
		return err
	}
	var err error
	start := 0
	for _, end := range e.ends {
		if err = e.d.renderPicture(e.context, e.bufs[start:end]...); err != nil {
			e.destroyBufs(end)
			break
		}
		start = end
	}
	if endErr := e.d.endPicture(e.context); err == nil {
		err = endErr
	}
	return err
}

func (e *vaEncoder) destroyBufs(from int) {
	for _, id := range e.bufs[from:] {
		e.d.destroyBuffer(id)
	}
}

func (e *vaEncoder) fillPicture(idr bool, cur, prev vaSurfaceID, poc int32, coded vaBufferID) {
	p := &e.pic
	p.CurrPic = vaPictureH264{PictureID: cur, FrameIdx: uint32(e.frameNum), TopFieldOrderCnt: poc, BottomFieldOrderCnt: poc}
	for i := range p.ReferenceFrames {
		p.ReferenceFrames[i] = vaInvalidPicture()
	}
	if !idr {
		p.ReferenceFrames[0] = vaPictureH264{PictureID: prev, FrameIdx: uint32(e.frameNum - 1), Flags: vaPictureH264ShortTermRef,
			TopFieldOrderCnt: poc - 2, BottomFieldOrderCnt: poc - 2}
	}
	p.CodedBuf = coded
	p.FrameNum = uint16(e.frameNum)
	p.PicFields = 1<<vaEncPicReferencePic | 1<<vaEncPicDeblockingControl
	if idr {
		p.PicFields |= 1 << vaEncPicIdr
	}
	if e.cfg.CABAC {
		p.PicFields |= 1 << vaEncPicEntropyCoding
	}
	if e.cfg.Profile == h264ProfileHigh {
		p.PicFields |= 1 << vaEncPicTransform8x8
	}
}

func (e *vaEncoder) fillSlice(idr bool, prev vaSurfaceID, poc int32) {
	s := &e.slice
	s.NumMacroblocks = uint32(e.cfg.mbW() * e.cfg.mbH())
	s.MacroblockInfo = vaInvalidID
	s.SliceType = h264SliceP
	if idr {
		s.SliceType = h264SliceI
	}
	s.IdrPicID = uint16(e.idrID)
	s.PicOrderCntLsb = uint16(poc) & (1<<e.cfg.Log2MaxPOCLsb - 1)
	for i := range s.RefPicList0 {
		s.RefPicList0[i] = vaInvalidPicture()
		s.RefPicList1[i] = vaInvalidPicture()
	}
	if !idr {
		s.RefPicList0[0] = e.pic.ReferenceFrames[0]
	}
}

// run waits for the hardware to finish each picture, in order, and hands the access unit on.
func (e *vaEncoder) run() {
	defer e.wg.Done()
	for slot := range e.done {
		if err := e.finish(slot); err != nil {
			e.broken.Store(true)
		}
		e.free <- slot
	}
}

func (e *vaEncoder) finish(slot *vaEncSlot) error {
	if err := e.d.syncSurface(slot.input); err != nil {
		return err
	}
	p, err := e.d.mapBuffer(slot.coded)
	if err != nil {
		return err
	}
	defer e.d.unmapBuffer(slot.coded)
	e.au = e.au[:0]
	if slot.idr {
		e.au = append(append(e.au, e.sps...), e.pps...)
	}
	for seg := (*vaCodedBufferSegment)(p); seg != nil; seg = (*vaCodedBufferSegment)(addr(seg.Next)) {
		if seg.Status&vaCodedBufStatusSliceOverfl != 0 {
			return errors.New("VA-API encoder: the coded picture does not fit its buffer")
		}
		e.au = appendVideoNALs(e.au, unsafe.Slice((*byte)(addr(seg.Buf)), seg.Size))
	}
	if len(e.au) > 0 {
		e.onAU(e.au)
	}
	return nil
}

func (e *vaEncoder) Close() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.closed = true
	e.mu.Unlock()
	close(e.done)
	e.wg.Wait()
	e.destroy()
}

func (e *vaEncoder) destroy() {
	d := e.d
	for _, s := range e.drainSlots() {
		d.destroyBuffer(s.coded)
	}
	if e.image.ImageID != 0 {
		d.destroyImage(e.image.ImageID)
	}
	if e.context != 0 {
		d.destroyContext(e.context)
	}
	if len(e.input) > 0 {
		d.destroySurfaces(append(append([]vaSurfaceID(nil), e.input...), e.recon[:]...))
	}
	if e.config != 0 {
		d.destroyConfig(e.config)
	}
	d.Close()
}

func (e *vaEncoder) drainSlots() []*vaEncSlot {
	var out []*vaEncSlot
	for {
		select {
		case s := <-e.free:
			out = append(out, s)
		default:
			return out
		}
	}
}
