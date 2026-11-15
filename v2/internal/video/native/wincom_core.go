//go:build windows

// COM from Go without cgo: system DLLs loaded lazily, interface calls through the vtable, HRESULTs as errors, GUIDs in the
// memory layout Windows uses. 64-bit Windows only (amd64, arm64): 64-bit integers are passed as one word.
package native

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

const ptrSize = unsafe.Sizeof(uintptr(0))

type hresult int32

// The HRESULTs Media Foundation transforms answer with, as the signed 32-bit values of their documented hex codes.
const (
	hrNeedMoreInput hresult = -1072861838 // MF_E_TRANSFORM_NEED_MORE_INPUT 0xC00D6D72
	hrStreamChange  hresult = -1072861855 // MF_E_TRANSFORM_STREAM_CHANGE 0xC00D6D61
	hrTypeNotSet    hresult = -1072861856 // MF_E_TRANSFORM_TYPE_NOT_SET 0xC00D6D60
	hrNotAccepting  hresult = -1072875851 // MF_E_NOTACCEPTING 0xC00D36B5
	hrNoMoreTypes   hresult = -1072875847 // MF_E_NO_MORE_TYPES 0xC00D36B9
	hrAttrNotFound  hresult = -1072875802 // MF_E_ATTRIBUTENOTFOUND 0xC00D36E6
	hrShutdown      hresult = -1072873851 // MF_E_SHUTDOWN 0xC00D3E85
	hrNoEvents      hresult = -1072873856 // MF_E_NO_EVENTS_AVAILABLE 0xC00D3E80
	hrNotImpl       hresult = -2147467263 // E_NOTIMPL 0x80004001
	hrNoInterface   hresult = -2147467262 // E_NOINTERFACE 0x80004002
	hrChangedMode   hresult = -2147417850 // RPC_E_CHANGED_MODE 0x80010106
)

var hrNames = map[hresult]string{
	hrNeedMoreInput: "MF_E_TRANSFORM_NEED_MORE_INPUT", hrStreamChange: "MF_E_TRANSFORM_STREAM_CHANGE",
	hrTypeNotSet: "MF_E_TRANSFORM_TYPE_NOT_SET", hrNotAccepting: "MF_E_NOTACCEPTING", hrNoMoreTypes: "MF_E_NO_MORE_TYPES",
	hrAttrNotFound: "MF_E_ATTRIBUTENOTFOUND", hrShutdown: "MF_E_SHUTDOWN", hrNoEvents: "MF_E_NO_EVENTS_AVAILABLE",
	hrNotImpl: "E_NOTIMPL", hrNoInterface: "E_NOINTERFACE", hrChangedMode: "RPC_E_CHANGED_MODE",
	-2147467259: "E_FAIL", -2147024809: "E_INVALIDARG", -2147024882: "E_OUTOFMEMORY",
}

func (h hresult) Error() string {
	if name, ok := hrNames[h]; ok {
		return fmt.Sprintf("%s (0x%08X)", name, uint32(h))
	}
	return fmt.Sprintf("HRESULT 0x%08X", uint32(h))
}

func (h hresult) failed() bool { return h < 0 }

// err is nil for a success code, otherwise the HRESULT with what was being done.
func (h hresult) err(op string) error {
	if h >= 0 {
		return nil
	}
	return &comError{op, h}
}

type comError struct {
	op string
	hr hresult
}

func (e *comError) Error() string { return e.op + ": " + e.hr.Error() }
func (e *comError) Unwrap() error { return e.hr }

// guid has the layout of the Windows GUID: the first three fields little endian, the last eight bytes as written.
type guid struct {
	d1 uint32
	d2 uint16
	d3 uint16
	d4 [8]byte
}

// mustGUID reads the registry form "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
func mustGUID(s string) guid {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		panic("bad GUID " + s)
	}
	hex := func(i, n int) uint64 {
		var v uint64
		for _, c := range []byte(s[i : i+n]) {
			switch {
			case c >= '0' && c <= '9':
				c -= '0'
			case c >= 'a' && c <= 'f':
				c = c - 'a' + 10
			case c >= 'A' && c <= 'F':
				c = c - 'A' + 10
			default:
				panic("bad GUID " + s)
			}
			v = v<<4 | uint64(c)
		}
		return v
	}
	g := guid{d1: uint32(hex(0, 8)), d2: uint16(hex(9, 4)), d3: uint16(hex(14, 4))}
	for i := 0; i < 8; i++ {
		j := 19 + i*2
		if i >= 2 {
			j++
		}
		g.d4[i] = byte(hex(j, 2))
	}
	return g
}

// p is the address for a call. g must be a package-level variable (or otherwise kept alive by the caller).
func (g *guid) p() uintptr { return uintptr(unsafe.Pointer(g)) }

// words is the GUID as the two 64-bit halves of its memory, for calls that take a GUID by value on arm64.
func (g *guid) words() (lo, hi uint64) {
	lo = uint64(g.d1) | uint64(g.d2)<<32 | uint64(g.d3)<<48
	for i := 7; i >= 0; i-- {
		hi = hi<<8 | uint64(g.d4[i])
	}
	return
}

var (
	iidIUnknown = mustGUID("00000000-0000-0000-c000-000000000046")

	guidMediaTypeVideo = mustGUID("73646976-0000-0010-8000-00aa00389b71")
	guidVideoH264      = mustGUID("34363248-0000-0010-8000-00aa00389b71")
	guidVideoNV12      = mustGUID("3231564e-0000-0010-8000-00aa00389b71")
	guidVideoRGB32     = mustGUID("00000016-0000-0010-8000-00aa00389b71")
	guidCategoryDec    = mustGUID("d6c02d4b-6833-45b4-971a-05a4b04bab91")
	guidCategoryEnc    = mustGUID("f79eac7d-e545-4387-bdee-d647d7bde42a")

	mfMTMajorType        = mustGUID("48eba18e-f8c9-4687-bf11-0a74c9f96a8f")
	mfMTSubtype          = mustGUID("f7e34c9a-42e8-4714-b74b-cb29d72c35e5")
	mfMTFrameSize        = mustGUID("1652c33d-d6b2-4012-b834-72030849a37d")
	mfMTFrameRate        = mustGUID("c459a2e8-3d2c-4e44-b132-fee5156c7bb0")
	mfMTMinDisplayApert  = mustGUID("d7388766-18fe-48c6-a177-ee894867c8c4")
	mfMTDefaultStride    = mustGUID("644b4e48-1e02-4516-b0eb-c01ca9d49ac6")
	mfMTYUVMatrix        = mustGUID("3e23d450-2c75-4d25-a00e-b91670d12327")
	mfMTVideoNominalRng  = mustGUID("c21b8ee5-b956-4071-8daf-325edf5cab11")
	mfMTInterlaceMode    = mustGUID("e2724bb8-e676-4806-b4b2-a8d6efb44ccd")
	mfLowLatency         = mustGUID("9c27891a-ed7a-40e1-88e8-b22727a024ee")
	mfTransformAsync     = mustGUID("f81a699a-649a-497d-8c73-29f8fed6ad7a")
	mfTransformAsyncUnlk = mustGUID("e5666d6b-3422-4eb6-a421-da7db1f8e207")
	mfSAD3D11Aware       = mustGUID("206b4fc8-fcf9-4c51-afe3-9764369e33a0")
	mftFriendlyName      = mustGUID("314ffbae-5b41-4c95-9c19-4e7d586face3")
	mftHardwareVendorID  = mustGUID("3aecb0cc-035b-4bcc-8185-2b8d551ef3af")

	iidIMFTransform          = mustGUID("bf94c121-5b05-4e6f-8000-ba598961414d")
	iidIMF2DBuffer           = mustGUID("7dc9d5f9-9ed9-44ec-9bbf-0600bb589fbb")
	iidID3D11Texture2D       = mustGUID("6f15aaf2-d208-4e89-9ab4-489535d34f9c")
	iidIMFDXGIBuffer         = mustGUID("e7174cfa-1c9e-48b1-8866-626226bfc258")
	iidIMFMediaEventGen      = mustGUID("2cd0bd52-bcd5-4b89-b62c-eadc0c031e7d")
	iidIMFAsyncCallback      = mustGUID("a27003cf-2354-4f2a-8d6a-ab7cff15437e")
	clsidMSH264DecoderMFT    = mustGUID("62ce7e72-4c71-4d20-b15d-452831a87d9d")
	iidID3D11Multithread     = mustGUID("9b7e4e00-342c-4106-a19f-4f2704f689f0")
	iidID3D11VideoDevice     = mustGUID("10ec4d5b-975a-4689-b9e4-d0aac30fe333")
	iidIDXGIFactory1         = mustGUID("770aae78-f26f-4dba-a829-253c83d1b387")
	guidDecoderProfileH264NF = mustGUID("1b81be68-a0c7-11d3-b984-00c04f2e73c5")
)

var (
	dllOle32  = syscall.NewLazyDLL("ole32.dll")
	dllMfplat = syscall.NewLazyDLL("mfplat.dll")

	procCoInitializeEx   = dllOle32.NewProc("CoInitializeEx")
	procCoUninitialize   = dllOle32.NewProc("CoUninitialize")
	procCoCreateInstance = dllOle32.NewProc("CoCreateInstance")
	procCoTaskMemFree    = dllOle32.NewProc("CoTaskMemFree")

	procMFStartup             = dllMfplat.NewProc("MFStartup")
	procMFShutdown            = dllMfplat.NewProc("MFShutdown")
	procMFCreateSample        = dllMfplat.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer  = dllMfplat.NewProc("MFCreateMemoryBuffer")
	procMFCreateMediaType     = dllMfplat.NewProc("MFCreateMediaType")
	procMFCreateAttributes    = dllMfplat.NewProc("MFCreateAttributes")
	procMFTEnumEx             = dllMfplat.NewProc("MFTEnumEx")
	procMFCreateDXGIDevManger = dllMfplat.NewProc("MFCreateDXGIDeviceManager")
)

// callProc calls a DLL function. Pointers to out values go in as uintptr(unsafe.Pointer(&v)) straight in the argument
// list, which keeps v alive and off the stack for the call.
//
//go:uintptrescapes
func callProc(p *syscall.LazyProc, args ...uintptr) hresult {
	if err := p.Find(); err != nil {
		return hresult(-2147024770) // HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND / PROC_NOT_FOUND)
	}
	r, _, _ := syscall.SyscallN(p.Addr(), args...)
	return hresult(int32(r))
}

// at turns an address handed out by Windows into a pointer.
func at(addr uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&addr)) }

func peek(addr uintptr) uintptr { return *(*uintptr)(at(addr)) }

// bytesAt views n bytes of memory that Windows owns.
func bytesAt(addr uintptr, n int) []byte {
	if addr == 0 || n <= 0 {
		return nil
	}
	return unsafe.Slice((*byte)(at(addr)), n)
}

// com is a pointer to a COM interface; slot numbers count IUnknown's three methods first.
type com uintptr

//go:uintptrescapes
func (c com) raw(slot int, args ...uintptr) uintptr {
	var a [16]uintptr
	a[0] = uintptr(c)
	n := copy(a[1:], args)
	fn := peek(peek(uintptr(c)) + uintptr(slot)*ptrSize)
	r, _, _ := syscall.SyscallN(fn, a[:n+1]...)
	return r
}

//go:uintptrescapes
func (c com) call(slot int, args ...uintptr) hresult {
	return hresult(int32(c.raw(slot, args...)))
}

func (c com) addRef() { c.raw(1) }

func (c com) release() {
	if c != 0 {
		c.raw(2)
	}
}

func (c com) queryInterface(iid *guid) (com, error) {
	out := new(uintptr)
	if hr := c.call(0, iid.p(), uintptr(unsafe.Pointer(out))); hr.failed() {
		return 0, hr.err("QueryInterface")
	}
	return com(*out), nil
}

// comSession readies the calling goroutine for COM and Media Foundation: it stays on its thread, joins the multithreaded
// apartment and starts Media Foundation. end undoes all of it and must be called on the same goroutine.
func comSession() (end func(), err error) {
	runtime.LockOSThread()
	hr := callProc(procCoInitializeEx, 0, 0) // COINIT_MULTITHREADED
	inited := !hr.failed()
	if hr.failed() && hr != hrChangedMode {
		runtime.UnlockOSThread()
		return nil, hr.err("CoInitializeEx")
	}
	const mfVersion = 0x20070 // MF_SDK_VERSION 2 << 16 | MF_API_VERSION 0x70
	if hr := callProc(procMFStartup, mfVersion, 0); hr.failed() {
		if inited {
			callProc(procCoUninitialize)
		}
		runtime.UnlockOSThread()
		return nil, hr.err("MFStartup (Media Foundation is not installed: Windows N editions need the Media Feature Pack)")
	}
	return func() {
		callProc(procMFShutdown)
		if inited {
			callProc(procCoUninitialize)
		}
		runtime.UnlockOSThread()
	}, nil
}

func coCreateInstance(clsid, iid *guid) (com, error) {
	out := new(uintptr)
	const clsctxInprocServer = 1
	if hr := callProc(procCoCreateInstance, clsid.p(), 0, clsctxInprocServer, iid.p(), uintptr(unsafe.Pointer(out))); hr.failed() {
		return 0, hr.err("CoCreateInstance")
	}
	return com(*out), nil
}

func coTaskMemFree(p uintptr) {
	if p != 0 {
		callProc(procCoTaskMemFree, p)
	}
}

// utf16At reads a zero terminated UTF-16 string.
func utf16At(p uintptr) string {
	if p == 0 {
		return ""
	}
	n := 0
	for *(*uint16)(at(p + uintptr(n)*2)) != 0 {
		n++
	}
	return syscall.UTF16ToString(unsafe.Slice((*uint16)(at(p)), n))
}
