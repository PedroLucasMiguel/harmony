//go:build windows

// Media Foundation interfaces as thin wrappers over vtable calls. Slot numbers come from the interface declarations in
// mfobjects.h and mftransform.h (IUnknown's QueryInterface, AddRef, Release are slots 0 to 2).
package native

import (
	"runtime"
	"syscall"
	"unsafe"
)

// IMFAttributes slots; IMFMediaType, IMFSample and IMFActivate extend it.
const (
	slotGetUINT32          = 7
	slotGetUINT64          = 8
	slotGetGUID            = 10
	slotGetAllocatedString = 13
	slotGetBlob            = 15
	slotSetUINT32          = 21
	slotSetUINT64          = 22
	slotSetGUID            = 24
	slotSetString          = 25
	slotSetBlob            = 26
	slotAttrCount          = 30
)

type mfAttributes struct{ com }

func mfCreateAttributes(size int) (mfAttributes, error) {
	out := new(uintptr)
	if hr := callProc(procMFCreateAttributes, uintptr(unsafe.Pointer(out)), uintptr(size)); hr.failed() {
		return mfAttributes{}, hr.err("MFCreateAttributes")
	}
	return mfAttributes{com(*out)}, nil
}

func (a mfAttributes) setUINT32(key *guid, v uint32) error {
	return a.call(slotSetUINT32, key.p(), uintptr(v)).err("SetUINT32")
}

func (a mfAttributes) setUINT64(key *guid, v uint64) error {
	return a.call(slotSetUINT64, key.p(), uintptr(v)).err("SetUINT64")
}

func (a mfAttributes) setGUID(key, v *guid) error {
	return a.call(slotSetGUID, key.p(), v.p()).err("SetGUID")
}

func (a mfAttributes) setString(key *guid, s string) error {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		return err
	}
	return a.call(slotSetString, key.p(), uintptr(unsafe.Pointer(p))).err("SetString")
}

func (a mfAttributes) setBlob(key *guid, b []byte) error {
	if len(b) == 0 {
		return hrNotImpl.err("SetBlob")
	}
	return a.call(slotSetBlob, key.p(), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b))).err("SetBlob")
}

// getUINT32 reports ok false when the attribute is not there; any other failure is an error.
func (a mfAttributes) getUINT32(key *guid) (v uint32, ok bool, err error) {
	hr := a.call(slotGetUINT32, key.p(), uintptr(unsafe.Pointer(&v)))
	return v, hr >= 0, notFound(hr, "GetUINT32")
}

func (a mfAttributes) getUINT64(key *guid) (v uint64, ok bool, err error) {
	hr := a.call(slotGetUINT64, key.p(), uintptr(unsafe.Pointer(&v)))
	return v, hr >= 0, notFound(hr, "GetUINT64")
}

func (a mfAttributes) getGUID(key *guid) (v guid, ok bool, err error) {
	hr := a.call(slotGetGUID, key.p(), uintptr(unsafe.Pointer(&v)))
	return v, hr >= 0, notFound(hr, "GetGUID")
}

// getBlob copies the attribute into b and reports how many bytes it holds.
func (a mfAttributes) getBlob(key *guid, b []byte) (n int, ok bool, err error) {
	var got uint32
	hr := a.call(slotGetBlob, key.p(), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), uintptr(unsafe.Pointer(&got)))
	return int(got), hr >= 0, notFound(hr, "GetBlob")
}

func (a mfAttributes) getString(key *guid) (s string, ok bool, err error) {
	var p uintptr
	var n uint32
	hr := a.call(slotGetAllocatedString, key.p(), uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&n)))
	if hr >= 0 {
		s = utf16At(p)
		coTaskMemFree(p)
	}
	return s, hr >= 0, notFound(hr, "GetAllocatedString")
}

func notFound(hr hresult, op string) error {
	if hr >= 0 || hr == hrAttrNotFound {
		return nil
	}
	return hr.err(op)
}

// mfMediaType is an IMFMediaType.
type mfMediaType struct{ mfAttributes }

func mfCreateMediaType() (mfMediaType, error) {
	out := new(uintptr)
	if hr := callProc(procMFCreateMediaType, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfMediaType{}, hr.err("MFCreateMediaType")
	}
	return mfMediaType{mfAttributes{com(*out)}}, nil
}

func (t mfMediaType) subtype() (g guid, ok bool) {
	g, ok, _ = t.getGUID(&mfMTSubtype)
	return
}

// size reads MF_MT_FRAME_SIZE (width in the high half, height in the low half).
func (t mfMediaType) size() (w, h int, ok bool) {
	v, ok, _ := t.getUINT64(&mfMTFrameSize)
	return int(v >> 32), int(uint32(v)), ok
}

func (t mfMediaType) setSize(w, h int) error {
	return t.setUINT64(&mfMTFrameSize, uint64(w)<<32|uint64(h))
}

func (t mfMediaType) setRatio(key *guid, num, den int) error {
	return t.setUINT64(key, uint64(num)<<32|uint64(den))
}

// mfVideoArea is MFVideoArea: two MFOffset (a 16-bit fraction then a 16-bit value) and a SIZE.
type mfVideoArea struct {
	offsetXFract uint16
	offsetX      int16
	offsetYFract uint16
	offsetY      int16
	width        int32
	height       int32
}

// mfSample is an IMFSample.
type mfSample struct{ mfAttributes }

func mfCreateSample() (mfSample, error) {
	out := new(uintptr)
	if hr := callProc(procMFCreateSample, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfSample{}, hr.err("MFCreateSample")
	}
	return mfSample{mfAttributes{com(*out)}}, nil
}

func (s mfSample) setSampleTime(t100ns int64) error {
	return s.call(36, uintptr(t100ns)).err("SetSampleTime")
}
func (s mfSample) setSampleDuration(d100ns int64) error {
	return s.call(38, uintptr(d100ns)).err("SetSampleDuration")
}
func (s mfSample) addBuffer(b mfBuffer) error { return s.call(42, uintptr(b.com)).err("AddBuffer") }

// buffer returns the one buffer of the sample, joining several into one when there are more.
func (s mfSample) buffer() (mfBuffer, error) {
	out := new(uintptr)
	if hr := s.call(41, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfBuffer{}, hr.err("ConvertToContiguousBuffer")
	}
	return mfBuffer{com(*out)}, nil
}

// mfBuffer is an IMFMediaBuffer.
type mfBuffer struct{ com }

func mfCreateMemoryBuffer(size int) (mfBuffer, error) {
	out := new(uintptr)
	if hr := callProc(procMFCreateMemoryBuffer, uintptr(size), uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfBuffer{}, hr.err("MFCreateMemoryBuffer")
	}
	return mfBuffer{com(*out)}, nil
}

// lock returns the buffer's memory, how much it can hold and how much is in it; it stays valid until unlock.
func (b mfBuffer) lock() (p uintptr, max, cur int, err error) {
	var m, c uint32
	if hr := b.call(3, uintptr(unsafe.Pointer(&p)), uintptr(unsafe.Pointer(&m)), uintptr(unsafe.Pointer(&c))); hr.failed() {
		return 0, 0, 0, hr.err("IMFMediaBuffer::Lock")
	}
	return p, int(m), int(c), nil
}

func (b mfBuffer) unlock()               { b.call(4) }
func (b mfBuffer) setLength(n int) error { return b.call(6, uintptr(n)).err("SetCurrentLength") }
func (b mfBuffer) maxLength() (int, error) {
	var n uint32
	hr := b.call(7, uintptr(unsafe.Pointer(&n)))
	return int(n), hr.err("GetMaxLength")
}
func (b mfBuffer) length() (int, error) {
	var n uint32
	hr := b.call(5, uintptr(unsafe.Pointer(&n)))
	return int(n), hr.err("GetCurrentLength")
}

// mfActivate is an IMFActivate (from MFTEnumEx or MFEnumDeviceSources).
type mfActivate struct{ mfAttributes }

func (a mfActivate) activate(iid *guid) (com, error) {
	out := new(uintptr)
	if hr := a.call(33, iid.p(), uintptr(unsafe.Pointer(out))); hr.failed() {
		return 0, hr.err("ActivateObject")
	}
	return com(*out), nil
}

func (a mfActivate) shutdownObject() { a.call(34) }

// mftRegisterTypeInfo is MFT_REGISTER_TYPE_INFO: a major type and a subtype, 32 bytes.
type mftRegisterTypeInfo struct{ major, sub guid }

// mftEnumEx lists the transforms of a category that take the input type (nil for any) and make the output type (nil for
// any). The activates are the caller's to release.
func mftEnumEx(category *guid, flags uint32, in, out *mftRegisterTypeInfo) ([]mfActivate, error) {
	var arr uintptr
	var n uint32
	var hr hresult
	if runtime.GOARCH == "arm64" {
		// a 16 byte struct passed by value travels in two registers on arm64 and by address on amd64
		lo, hi := category.words()
		hr = callProc(procMFTEnumEx, uintptr(lo), uintptr(hi), uintptr(flags), uintptr(unsafe.Pointer(in)), uintptr(unsafe.Pointer(out)),
			uintptr(unsafe.Pointer(&arr)), uintptr(unsafe.Pointer(&n)))
	} else {
		hr = callProc(procMFTEnumEx, category.p(), uintptr(flags), uintptr(unsafe.Pointer(in)), uintptr(unsafe.Pointer(out)),
			uintptr(unsafe.Pointer(&arr)), uintptr(unsafe.Pointer(&n)))
	}
	if hr.failed() {
		return nil, hr.err("MFTEnumEx")
	}
	list := make([]mfActivate, n)
	for i := range list {
		list[i] = mfActivate{mfAttributes{com(peek(arr + uintptr(i)*ptrSize))}}
	}
	coTaskMemFree(arr)
	return list, nil
}

const (
	mftEnumSync        = 0x1
	mftEnumAsync       = 0x2
	mftEnumHardware    = 0x4
	mftEnumSortFilter  = 0x40
	mftEnumLocalMFT    = 0x10
	mftMsgFlush        = 0x0
	mftMsgDrain        = 0x1
	mftMsgSetD3DMgr    = 0x2
	mftMsgBeginStream  = 0x10000000
	mftMsgEndStream    = 0x10000001
	mftMsgEndOfStream  = 0x10000002
	mftMsgStartStream  = 0x10000003
	mftOutProvides     = 0x100
	mftOutCanProvide   = 0x200
	mftOutFormatChange = 0x100
)

// mftOutputStreamInfo is MFT_OUTPUT_STREAM_INFO.
type mftOutputStreamInfo struct{ flags, size, alignment uint32 }

// mftOutputDataBuffer is MFT_OUTPUT_DATA_BUFFER: Go's layout rules give the padding the C struct has.
type mftOutputDataBuffer struct {
	streamID uint32
	sample   uintptr
	status   uint32
	events   uintptr
}

// mfTransform is an IMFTransform.
type mfTransform struct{ com }

func (t mfTransform) attributes() (mfAttributes, bool) {
	out := new(uintptr)
	if hr := t.call(8, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfAttributes{}, false
	}
	return mfAttributes{com(*out)}, true
}

func (t mfTransform) outputStreamInfo(info *mftOutputStreamInfo) error {
	return t.call(7, 0, uintptr(unsafe.Pointer(info))).err("GetOutputStreamInfo")
}

// outputAvailableType returns hrNoMoreTypes past the last type.
func (t mfTransform) outputAvailableType(index int) (mfMediaType, hresult) {
	out := new(uintptr)
	hr := t.call(14, 0, uintptr(index), uintptr(unsafe.Pointer(out)))
	if hr.failed() {
		return mfMediaType{}, hr
	}
	return mfMediaType{mfAttributes{com(*out)}}, hr
}

func (t mfTransform) setInputType(mt mfMediaType) error {
	return t.call(15, 0, uintptr(mt.com), 0).err("SetInputType")
}

func (t mfTransform) setOutputType(mt mfMediaType) error {
	return t.call(16, 0, uintptr(mt.com), 0).err("SetOutputType")
}

func (t mfTransform) outputCurrentType() (mfMediaType, error) {
	out := new(uintptr)
	if hr := t.call(18, 0, uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfMediaType{}, hr.err("GetOutputCurrentType")
	}
	return mfMediaType{mfAttributes{com(*out)}}, nil
}

func (t mfTransform) processMessage(msg uint32, param uintptr) hresult {
	return t.call(23, uintptr(msg), param)
}

func (t mfTransform) processInput(s mfSample) hresult { return t.call(24, 0, uintptr(s.com), 0) }

// processOutput fills out and status, which the caller keeps alive on the heap for the call.
func (t mfTransform) processOutput(out *mftOutputDataBuffer, status *uint32) hresult {
	return t.call(25, 0, 1, uintptr(unsafe.Pointer(out)), uintptr(unsafe.Pointer(status)))
}

// mfEventGenerator is the IMFMediaEventGenerator an asynchronous transform has.
type mfEventGenerator struct{ com }

// beginGetEvent asks for the next event to be handed to cb (an IMFAsyncCallback).
func (g mfEventGenerator) beginGetEvent(cb uintptr) hresult { return g.call(4, cb, 0) }

func (g mfEventGenerator) endGetEvent(result uintptr) (mfEvent, hresult) {
	out := new(uintptr)
	hr := g.call(5, result, uintptr(unsafe.Pointer(out)))
	return mfEvent{mfAttributes{com(*out)}}, hr
}

// mfEvent is an IMFMediaEvent.
type mfEvent struct{ mfAttributes }

func (e mfEvent) eventType() uint32 {
	var t uint32
	e.call(33, uintptr(unsafe.Pointer(&t)))
	return t
}

// MediaEventType values of the transform events.
const (
	meTransformNeedInput  = 601
	meTransformHaveOutput = 602
	meTransformDrained    = 603
	meTransformMarker     = 604
)

// mfDXGIManager is an IMFDXGIDeviceManager.
type mfDXGIManager struct{ com }

func mfCreateDXGIDeviceManager() (mfDXGIManager, uint32, error) {
	var token uint32
	out := new(uintptr)
	if hr := callProc(procMFCreateDXGIDevManger, uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(out))); hr.failed() {
		return mfDXGIManager{}, 0, hr.err("MFCreateDXGIDeviceManager")
	}
	return mfDXGIManager{com(*out)}, token, nil
}

func (m mfDXGIManager) resetDevice(device com, token uint32) error {
	return m.call(7, uintptr(device), uintptr(token)).err("IMFDXGIDeviceManager::ResetDevice")
}
