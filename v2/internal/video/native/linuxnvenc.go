//go:build linux

// H.264 encoding with NVENC, the encoder in NVIDIA graphics cards, through the driver's libnvidia-encode.so.1 and a CUDA
// context. A picture is converted to NV12 straight into an NVENC input buffer in the caller's goroutine, and a goroutine of
// the encoder runs the card and hands over the Annex B access unit. A picture that arrives while the card is still busy is
// dropped.
package native

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"
)

// nvEncAPI is the driver's entry points, found once.
type nvEncAPI struct {
	fn nvEncFunctions
}

func (s *nvSystem) probeEncode() error {
	lib, err := nvOpenLibrary(nvEncodeLib, "install the NVIDIA driver's encode library, the libnvidia-encode package of the driver")
	if err != nil {
		return err
	}
	f, err := nvSymbols(lib, nvEncodeLib, "NvEncodeAPICreateInstance", "NvEncodeAPIGetMaxSupportedVersion")
	if err != nil {
		return err
	}
	var max uint32
	if st := nvResult(nvCall(f[1], uintptr(unsafe.Pointer(&max)))); st != 0 {
		return fmt.Errorf("NvEncodeAPIGetMaxSupportedVersion failed: %s", nvEncStatusName(st))
	}
	if max < 11<<4|1 {
		return fmt.Errorf("the NVIDIA driver's NVENC is version %d.%d and this client needs 11.1: update the driver (470 or newer)", max>>4, max&15)
	}
	s.enc.fn.version = nvEncFunctionListVer
	if st := nvResult(nvCall(f[0], uintptr(unsafe.Pointer(&s.enc.fn)))); st != 0 {
		return fmt.Errorf("NvEncodeAPICreateInstance failed: %s", nvEncStatusName(st))
	}
	fn := &s.enc.fn
	for _, p := range []uintptr{fn.openEncodeSessionEx, fn.getEncodeGUIDCount, fn.getEncodeGUIDs, fn.getEncodeProfileGUIDCount, fn.getEncodeProfileGUIDs, fn.getEncodeCaps,
		fn.getEncodePresetConfigEx, fn.initializeEncoder, fn.createInputBuffer, fn.destroyInputBuffer, fn.createBitstreamBuffer,
		fn.destroyBitstreamBuffer, fn.encodePicture, fn.lockBitstream, fn.unlockBitstream, fn.lockInputBuffer,
		fn.unlockInputBuffer, fn.destroyEncoder, fn.getLastErrorString} {
		if p == 0 {
			return errors.New("the NVIDIA driver's NVENC does not have the functions this client needs")
		}
	}
	return s.confirmH264()
}

// confirmH264 opens a session and asks which codecs the card encodes.
func (s *nvSystem) confirmH264() error {
	if err := s.push(); err != nil {
		return err
	}
	defer s.pop()
	var session uintptr
	if err := s.openSession(&session); err != nil {
		return fmt.Errorf("the graphics card cannot encode with NVENC: %w", err)
	}
	defer nvCall(s.enc.fn.destroyEncoder, session)
	var n uint32
	guids := new([32]nvGUID)
	if st := nvResult(nvCall(s.enc.fn.getEncodeGUIDCount, session, uintptr(unsafe.Pointer(&n)))); st != 0 {
		return fmt.Errorf("NvEncGetEncodeGUIDCount failed: %s", nvEncStatusName(st))
	}
	if n > uint32(len(guids)) {
		n = uint32(len(guids))
	}
	var got uint32
	if st := nvResult(nvCall(s.enc.fn.getEncodeGUIDs, session, uintptr(unsafe.Pointer(&guids[0])), uintptr(n), uintptr(unsafe.Pointer(&got)))); st != 0 {
		return fmt.Errorf("NvEncGetEncodeGUIDs failed: %s", nvEncStatusName(st))
	}
	for _, g := range guids[:got] {
		if g == nvEncCodecH264 {
			return nil
		}
	}
	return errors.New("the graphics card's NVENC does not encode H.264")
}

// openSession opens an encode session on the process's CUDA context; the context must be current.
func (s *nvSystem) openSession(session *uintptr) error {
	p := new(nvEncOpenSession)
	p.version = nvEncOpenSessionVer
	p.deviceType = nvEncDeviceCUDA
	p.device = s.ctx
	p.apiVersion = nvEncAPIVersion
	if st := nvResult(nvCall(s.enc.fn.openEncodeSessionEx, uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(session)))); st != 0 {
		return fmt.Errorf("NvEncOpenEncodeSessionEx failed: %s", nvEncStatusName(st))
	}
	return nil
}

type nvEncoder struct {
	sys     *nvSystem
	fn      *nvEncFunctions
	session uintptr
	w, h    int
	matrix  int
	onAU    func([]byte)

	cfg    nvEncConfig
	init   nvEncInitParams
	pic    nvEncPicParams
	lockIn nvEncLockInput
	lockBS nvEncLockBitstream
	caps   nvEncCapsParam
	capVal int32
	inBuf  uintptr
	outBuf uintptr

	scratch []byte
	pitch   int

	key    atomic.Bool
	busy   atomic.Bool
	failed atomic.Pointer[error]
	work   chan struct{}
	done   chan struct{}

	mu     sync.Mutex
	closed bool
}

func newNVEncoder(p EncodeParams, onAU func([]byte)) (Encoder, error) {
	s := nvProbe()
	if s.encErr != nil {
		return nil, s.encErr
	}
	if p.Width < 2 || p.Height < 2 || p.Width&1 != 0 || p.Height&1 != 0 {
		return nil, fmt.Errorf("NVENC needs a picture of even size, not %dx%d", p.Width, p.Height)
	}
	if p.FPS <= 0 {
		p.FPS = 30
	}
	if p.BitrateKbps <= 0 {
		p.BitrateKbps = 2500
	}
	e := &nvEncoder{sys: s, fn: &s.enc.fn, w: p.Width, h: p.Height, matrix: p.Matrix, onAU: onAU,
		work: make(chan struct{}, 1), done: make(chan struct{})}
	if err := s.push(); err != nil {
		return nil, err
	}
	err := e.open(p)
	if err != nil {
		e.release()
	}
	s.pop()
	if err != nil {
		return nil, err
	}
	go e.run()
	return e, nil
}

// status turns a failed NVENC call into an error in the driver's words.
func (e *nvEncoder) status(op string, st uint32) error {
	msg := nvCString(nvCall(e.fn.getLastErrorString, e.session))
	if msg != "" {
		return fmt.Errorf("%s failed: %s: %s", op, nvEncStatusName(st), msg)
	}
	return fmt.Errorf("%s failed: %s", op, nvEncStatusName(st))
}

func (e *nvEncoder) capability(id uint32) (int32, error) {
	lo, hi := nvEncCodecH264.words()
	e.caps = nvEncCapsParam{version: nvEncCapsParamVer, capsToQuery: id}
	if st := nvResult(nvCall(e.fn.getEncodeCaps, e.session, lo, hi, uintptr(unsafe.Pointer(&e.caps)), uintptr(unsafe.Pointer(&e.capVal)))); st != 0 {
		return 0, e.status("NvEncGetEncodeCaps", st)
	}
	return e.capVal, nil
}

// open creates the session, configures it for low latency H.264 and makes the buffers. The CUDA context is current.
func (e *nvEncoder) open(p EncodeParams) error {
	if err := e.sys.openSession(&e.session); err != nil {
		return err
	}
	if max, err := e.capability(nvEncCapWidthMax); err != nil {
		return err
	} else if int32(e.w) > max {
		return fmt.Errorf("NVENC on this card encodes at most %d pixels wide, not %d", max, e.w)
	}
	if max, err := e.capability(nvEncCapHeightMax); err != nil {
		return err
	} else if int32(e.h) > max {
		return fmt.Errorf("NVENC on this card encodes at most %d pixels high, not %d", max, e.h)
	}

	preset := new(nvEncPresetConfig)
	preset.version = nvEncPresetConfigVer
	preset.preset.version = nvEncConfigVer
	glo, ghi := nvEncCodecH264.words()
	plo, phi := nvEncPresetP3.words()
	if st := nvResult(nvCall(e.fn.getEncodePresetConfigEx, e.session, glo, ghi, plo, phi, nvEncTuningUltraLow,
		uintptr(unsafe.Pointer(preset)))); st != 0 {
		return e.status("NvEncGetEncodePresetConfigEx", st)
	}
	e.cfg = preset.preset
	profile, err := e.pickProfile()
	if err != nil {
		return err
	}
	e.configure(p, profile)

	e.init = nvEncInitParams{
		version:         nvEncInitParamsVer,
		encodeGUID:      nvEncCodecH264,
		presetGUID:      nvEncPresetP3,
		encodeWidth:     uint32(e.w),
		encodeHeight:    uint32(e.h),
		darWidth:        uint32(e.w),
		darHeight:       uint32(e.h),
		frameRateNum:    uint32(p.FPS),
		frameRateDen:    1,
		enablePTD:       1,
		encodeConfig:    uintptr(unsafe.Pointer(&e.cfg)),
		maxEncodeWidth:  uint32(e.w),
		maxEncodeHeight: uint32(e.h),
		tuningInfo:      nvEncTuningUltraLow,
	}
	if st := nvResult(nvCall(e.fn.initializeEncoder, e.session, uintptr(unsafe.Pointer(&e.init)))); st != 0 {
		return e.status("NvEncInitializeEncoder", st)
	}

	in := &nvEncCreateInput{version: nvEncCreateInputVer, width: uint32(e.w), height: uint32(e.h), bufferFmt: nvEncBufferNV12}
	if st := nvResult(nvCall(e.fn.createInputBuffer, e.session, uintptr(unsafe.Pointer(in)))); st != 0 {
		return e.status("NvEncCreateInputBuffer", st)
	}
	e.inBuf = in.inputBuffer
	out := &nvEncCreateBitstream{version: nvEncCreateBitstreamVer, size: 1 << 20}
	if st := nvResult(nvCall(e.fn.createBitstreamBuffer, e.session, uintptr(unsafe.Pointer(out)))); st != 0 {
		return e.status("NvEncCreateBitstreamBuffer", st)
	}
	e.outBuf = out.bitstreamBuffer

	e.lockIn = nvEncLockInput{version: nvEncLockInputVer, inputBuffer: e.inBuf}
	e.lockBS = nvEncLockBitstream{version: nvEncLockBitstreamVer, outputBitstream: e.outBuf}
	e.pic = nvEncPicParams{
		version:         nvEncPicParamsVer,
		inputWidth:      uint32(e.w),
		inputHeight:     uint32(e.h),
		inputBuffer:     e.inBuf,
		outputBitstream: e.outBuf,
		bufferFmt:       nvEncBufferNV12,
		pictureStruct:   nvEncPicStructFrame,
	}
	e.scratch = make([]byte, nv12Size(e.w, e.h))
	return nil
}

// pickProfile is the best H.264 profile the card lists: High, then Main, then Baseline, as the Electron client orders them.
func (e *nvEncoder) pickProfile() (nvGUID, error) {
	glo, ghi := nvEncCodecH264.words()
	var n uint32
	if st := nvResult(nvCall(e.fn.getEncodeProfileGUIDCount, e.session, glo, ghi, uintptr(unsafe.Pointer(&n)))); st != 0 {
		return nvGUID{}, e.status("NvEncGetEncodeProfileGUIDCount", st)
	}
	guids := new([32]nvGUID)
	if n > uint32(len(guids)) {
		n = uint32(len(guids))
	}
	var got uint32
	if st := nvResult(nvCall(e.fn.getEncodeProfileGUIDs, e.session, glo, ghi, uintptr(unsafe.Pointer(&guids[0])), uintptr(n),
		uintptr(unsafe.Pointer(&got)))); st != 0 {
		return nvGUID{}, e.status("NvEncGetEncodeProfileGUIDs", st)
	}
	for _, want := range []nvGUID{nvEncProfileHigh, nvEncProfileMain, nvEncProfileBase} {
		for _, g := range guids[:got] {
			if g == want {
				return want, nil
			}
		}
	}
	return nvGUID{}, errors.New("the graphics card's NVENC lists no High, Main or Baseline H.264 profile")
}

// configure turns the preset into this stream: the profile chosen (High, Main or Baseline), no B frames, a key frame every two seconds with the parameter
// sets in front, constant bitrate, and the colour coding in the VUI (limited range, BT.709 primaries and transfer for
// either matrix, as the other encoders tag it).
func (e *nvEncoder) configure(p EncodeParams, profile nvGUID) {
	c := &e.cfg
	c.version = nvEncConfigVer
	c.profileGUID = profile
	gop := uint32(p.FPS * 2)
	c.gopLength = gop
	c.frameIntervalP = 1
	c.rc.version = nvEncRCParamsVer
	c.rc.rateControlMode = nvEncRCCBR
	c.rc.averageBitRate = uint32(p.BitrateKbps) * 1000
	c.rc.maxBitRate = c.rc.averageBitRate
	c.rc.vbvBufferSize = 0
	c.rc.vbvInitialDelay = 0
	c.rc.flags |= nvEncRCZeroReorderDelay

	h := &c.h264
	h.flags |= nvEncH264RepeatSPSPPS
	h.idrPeriod = gop
	h.maxNumRefFrames = 1
	h.chromaFormatIDC = 1
	if profile == nvEncProfileBase {
		h.entropyCodingMode = nvEncEntropyCAVLC
	}
	matrix := uint32(1)
	if p.Matrix == BT601 {
		matrix = 6
	}
	h.vui = nvEncH264VUI{
		videoSignalTypePresent:   1,
		videoFormat:              5,
		colourDescriptionPresent: 1,
		colourPrimaries:          1,
		transferCharacteristics:  1,
		colourMatrix:             matrix,
		bitstreamRestrictionFlag: 1,
	}
}

func (e *nvEncoder) KeyFrame() { e.key.Store(true) }

func (e *nvEncoder) Mode() string { return "nvenc" }

func (e *nvEncoder) EncodeBGRA(pix []byte, stride int) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errors.New("the encoder is closed")
	}
	if err := e.failure(); err != nil {
		return err
	}
	if stride < e.w*4 || len(pix) < (e.h-1)*stride+e.w*4 {
		return fmt.Errorf("a picture of %d bytes with rows of %d does not fill %dx%d", len(pix), stride, e.w, e.h)
	}
	if !e.busy.CompareAndSwap(false, true) {
		return nil
	}
	if err := e.upload(pix, stride); err != nil {
		e.busy.Store(false)
		return err
	}
	e.pic.encodePicFlags = 0
	if e.key.Swap(false) {
		e.pic.encodePicFlags = nvEncPicFlagForceIDR | nvEncPicFlagOutputSPPS
	}
	e.pic.inputTimeStamp++
	e.work <- struct{}{}
	return nil
}

func (e *nvEncoder) failure() error {
	if err := e.failed.Load(); err != nil {
		return *err
	}
	return nil
}

func (e *nvEncoder) fail(err error) { e.failed.CompareAndSwap(nil, &err) }

// upload converts the picture into the encoder's input buffer.
func (e *nvEncoder) upload(pix []byte, stride int) error {
	if err := e.sys.push(); err != nil {
		return err
	}
	defer e.sys.pop()
	if st := nvResult(nvCall(e.fn.lockInputBuffer, e.session, uintptr(unsafe.Pointer(&e.lockIn)))); st != 0 {
		return e.status("NvEncLockInputBuffer", st)
	}
	pitch := int(e.lockIn.pitch)
	if pitch < e.w {
		nvCall(e.fn.unlockInputBuffer, e.session, e.inBuf)
		return fmt.Errorf("NVENC gave an input buffer with rows of %d bytes for a picture %d wide", pitch, e.w)
	}
	dst := unsafe.Slice(nvAt[byte](e.lockIn.bufferDataPtr), pitch*e.h*3/2)
	if pitch == e.w {
		bgraToNV12(dst, pix, e.w, e.h, stride, e.matrix)
	} else {
		bgraToNV12(e.scratch, pix, e.w, e.h, stride, e.matrix)
		for y := 0; y < e.h; y++ {
			copy(dst[y*pitch:y*pitch+e.w], e.scratch[y*e.w:(y+1)*e.w])
		}
		luma := e.w * e.h
		for y := 0; y < e.h/2; y++ {
			copy(dst[(e.h+y)*pitch:(e.h+y)*pitch+e.w], e.scratch[luma+y*e.w:luma+(y+1)*e.w])
		}
	}
	if st := nvResult(nvCall(e.fn.unlockInputBuffer, e.session, e.inBuf)); st != 0 {
		return e.status("NvEncUnlockInputBuffer", st)
	}
	e.pic.inputPitch = uint32(pitch)
	return nil
}

// run is the encoder's goroutine: one picture at a time, from the card to onAU.
func (e *nvEncoder) run() {
	defer close(e.done)
	for range e.work {
		e.encodeOne()
		e.busy.Store(false)
	}
}

func (e *nvEncoder) encodeOne() {
	if err := e.sys.push(); err != nil {
		e.fail(err)
		return
	}
	defer e.sys.pop()
	st := nvResult(nvCall(e.fn.encodePicture, e.session, uintptr(unsafe.Pointer(&e.pic))))
	if st == nvEncNeedMoreInput {
		return
	}
	if st != nvEncSuccess {
		e.fail(e.status("NvEncEncodePicture", st))
		return
	}
	e.lockBS.flags = 0
	if st := nvResult(nvCall(e.fn.lockBitstream, e.session, uintptr(unsafe.Pointer(&e.lockBS)))); st != nvEncSuccess {
		e.fail(e.status("NvEncLockBitstream", st))
		return
	}
	if n := int(e.lockBS.bitstreamSizeInBytes); n > 0 && e.lockBS.bitstreamBufferPtr != 0 {
		e.onAU(unsafe.Slice(nvAt[byte](e.lockBS.bitstreamBufferPtr), n))
	}
	nvCall(e.fn.unlockBitstream, e.session, e.outBuf)
}

func (e *nvEncoder) Close() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.closed = true
	close(e.work)
	e.mu.Unlock()
	<-e.done
	if e.sys.push() == nil {
		e.release()
		e.sys.pop()
	}
}

// release frees what the card holds for this encoder; the CUDA context is current.
func (e *nvEncoder) release() {
	if e.inBuf != 0 {
		nvCall(e.fn.destroyInputBuffer, e.session, e.inBuf)
		e.inBuf = 0
	}
	if e.outBuf != 0 {
		nvCall(e.fn.destroyBitstreamBuffer, e.session, e.outBuf)
		e.outBuf = 0
	}
	if e.session != 0 {
		nvCall(e.fn.destroyEncoder, e.session)
		e.session = 0
	}
}

func nvEncoderInfo() []BackendInfo {
	if s := nvProbe(); s.encErr == nil {
		return []BackendInfo{{ID: NVIDIA, Name: s.gpu + " (NVENC)"}}
	}
	return nil
}
