//go:build darwin

package native

// The CoreFoundation, CoreMedia, CoreVideo and VideoToolbox entry points the macOS encoder and capture use, bound once
// with purego (no cgo). Names start with mx so they cannot meet another file's.

import (
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// cmTime is CMTime: value/timescale seconds; flags 1 is kCMTimeFlags_Valid.
type cmTime struct {
	Value int64
	Scale int32
	Flags uint32
	Epoch int64
}

const (
	mxNumSInt32  = 3
	mxNumFloat64 = 6

	mxFmtBGRA = 0x42475241 // 'BGRA'
	mxFmt420v = 0x34323076 // '420v'

	mxAttachPropagate = 1 // kCVAttachmentMode_ShouldPropagate
)

var mx struct {
	once sync.Once
	err  error

	cf, cm, cv, vt uintptr

	cfArrayCreate      func(alloc uintptr, v *uintptr, n int, cb uintptr) uintptr
	cfDictionaryCreate func(alloc uintptr, keys, vals *uintptr, n int, keyCB, valCB uintptr) uintptr
	cfNumberCreate     func(alloc uintptr, typ int, p unsafe.Pointer) uintptr
	cvPoolCreate       func(alloc, poolAttrs, bufAttrs uintptr, out *uintptr) int32
	vtCreate           func(alloc uintptr, w, h int32, codec uint32, spec, srcAttrs, dataAlloc, cb, refcon uintptr, out *uintptr) int32
	vtSetProperty      func(sess, key, val uintptr) int32
	vtCopyProperty     func(sess, key, alloc uintptr, out *uintptr) int32
	vtPrepare          func(sess uintptr) int32
	vtEncodeFrame      func(sess, pb uintptr, pts, dur cmTime, props, refcon uintptr, flags *uint32) int32
	vtCompleteFrames   func(sess uintptr, until cmTime) int32
	vtInvalidate       func(sess uintptr)
	vtXferCreate       func(alloc uintptr, out *uintptr) int32
	vtXferInvalidate   func(sess uintptr)

	cfTrue, cfFalse                                           uintptr
	cfArrCB                                                   uintptr
	cfKeyCB, cfValCB                                          uintptr
	kRealTime, kProfileLevel, kReorder, kAvgBitRate           uintptr
	kMaxKeyInt, kMaxKeyDur, kExpectedFPS, kPrioritize         uintptr
	kDataRateLimits, kUsingHW, kForceKey, kNotSync            uintptr
	kMaxDelay                                                 uintptr
	kSessPrimaries, kSessTransfer, kSessMatrix                uintptr
	kXferPrimaries, kXferTransfer, kXferMatrix, kXferRealTime uintptr
	kSpecEnableHW, kSpecRequireHW                             uintptr
	kPBFormat, kPBWidth, kPBHeight, kPBIOSurface              uintptr
	kSRGB                                                     uintptr
	kPrimaries, kTransfer, kMatrix                            uintptr
	vPrim709, vPrim601, vTransfer709, vMat709, vMat601        uintptr
	vProfileCB, vProfileHigh, vProfileBase, vProfileMain      uintptr
}

// mxFn are the addresses of the C functions called every frame, through mxCaller, which does not allocate.
var mxFn struct {
	cvBufferGetAttachment, cfRetain, cfNumberGetValue, cvWidth, cvHeight, cvPixelFormat, cmSampleImageBuffer, cfEqual        uintptr
	cfRelease, cfDictionaryGetValue, cfArrayGetCount, cfArrayGetValueAtIdx, cfBooleanGetValue                                uintptr
	cmSampleDataBuffer, cmSampleFormatDesc, cmSampleAttachments, cmBlockGetDataPointer, cmBlockCopyDataBytes, cmH264ParamSet uintptr
	cvPoolCreateBuffer, cvBufferSetAttachment, cvLockBase, cvUnlockBase, cvBaseAddress, cvBytesPerRow, vtXferRun             uintptr
}

// mxCaller calls C functions with a fixed argument buffer. One per thread of work; not safe for concurrent use.
type mxCaller struct{ a [12]uintptr }

func (c *mxCaller) call(fn uintptr, a ...uintptr) uintptr {
	n := copy(c.a[:], a)
	r, _, _ := purego.SyscallN(fn, c.a[:n]...)
	return r
}

// mxPtr is for pointers into heap memory only: a Go stack variable can move between this conversion and the C call.
func mxPtr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

func mxCFRelease(o uintptr) { var c mxCaller; c.call(mxFn.cfRelease, o) }

func mxBool(b uintptr) bool { var c mxCaller; return c.call(mxFn.cfBooleanGetValue, b)&0xff != 0 }

// mxFramework opens a system framework (already open frameworks are only looked up again).
func mxFramework(name string) uintptr {
	h, err := purego.Dlopen("/System/Library/Frameworks/"+name+".framework/"+name, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
	if err != nil {
		panic(err)
	}
	return h
}

func mxSymbol(lib uintptr, name string) uintptr {
	p, err := purego.Dlsym(lib, name)
	if err != nil {
		panic(err)
	}
	return p
}

// mxConstant reads a CFStringRef (or other object pointer) that a framework exports as a global variable.
func mxConstant(lib uintptr, name string) uintptr {
	p := mxSymbol(lib, name)
	return **(**uintptr)(unsafe.Pointer(&p))
}

func mxLoad() error {
	mx.once.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				mx.err = fmt.Errorf("VideoToolbox is not available: %v", r)
			}
		}()
		open := func(name string) uintptr {
			h, err := purego.Dlopen("/System/Library/Frameworks/"+name+".framework/"+name, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
			if err != nil {
				panic(err)
			}
			return h
		}
		mx.cf = open("CoreFoundation")
		mx.cm = open("CoreMedia")
		mx.cv = open("CoreVideo")
		mx.vt = open("VideoToolbox")
		reg := func(fn any, lib uintptr, name string) { purego.RegisterLibFunc(fn, lib, name) }
		reg(&mx.cfDictionaryCreate, mx.cf, "CFDictionaryCreate")
		reg(&mx.cfNumberCreate, mx.cf, "CFNumberCreate")
		reg(&mx.cvPoolCreate, mx.cv, "CVPixelBufferPoolCreate")
		reg(&mx.vtCreate, mx.vt, "VTCompressionSessionCreate")
		reg(&mx.vtSetProperty, mx.vt, "VTSessionSetProperty")
		reg(&mx.vtCopyProperty, mx.vt, "VTSessionCopyProperty")
		reg(&mx.vtPrepare, mx.vt, "VTCompressionSessionPrepareToEncodeFrames")
		reg(&mx.vtEncodeFrame, mx.vt, "VTCompressionSessionEncodeFrame")
		reg(&mx.vtCompleteFrames, mx.vt, "VTCompressionSessionCompleteFrames")
		reg(&mx.vtInvalidate, mx.vt, "VTCompressionSessionInvalidate")
		reg(&mx.vtXferCreate, mx.vt, "VTPixelTransferSessionCreate")
		reg(&mx.vtXferInvalidate, mx.vt, "VTPixelTransferSessionInvalidate")

		mxFn.cfRelease = mxSymbol(mx.cf, "CFRelease")
		mxFn.cfRetain = mxSymbol(mx.cf, "CFRetain")
		mxFn.cfNumberGetValue = mxSymbol(mx.cf, "CFNumberGetValue")
		mxFn.cfEqual = mxSymbol(mx.cf, "CFEqual")
		mxFn.cvWidth = mxSymbol(mx.cv, "CVPixelBufferGetWidth")
		mxFn.cvHeight = mxSymbol(mx.cv, "CVPixelBufferGetHeight")
		mxFn.cvPixelFormat = mxSymbol(mx.cv, "CVPixelBufferGetPixelFormatType")
		mxFn.cmSampleImageBuffer = mxSymbol(mx.cm, "CMSampleBufferGetImageBuffer")
		mxFn.cvBufferGetAttachment = mxSymbol(mx.cv, "CVBufferGetAttachment")
		mxFn.cfDictionaryGetValue = mxSymbol(mx.cf, "CFDictionaryGetValue")
		mxFn.cfArrayGetCount = mxSymbol(mx.cf, "CFArrayGetCount")
		mxFn.cfArrayGetValueAtIdx = mxSymbol(mx.cf, "CFArrayGetValueAtIndex")
		mxFn.cfBooleanGetValue = mxSymbol(mx.cf, "CFBooleanGetValue")
		mxFn.cmSampleDataBuffer = mxSymbol(mx.cm, "CMSampleBufferGetDataBuffer")
		mxFn.cmSampleFormatDesc = mxSymbol(mx.cm, "CMSampleBufferGetFormatDescription")
		mxFn.cmSampleAttachments = mxSymbol(mx.cm, "CMSampleBufferGetSampleAttachmentsArray")
		mxFn.cmBlockGetDataPointer = mxSymbol(mx.cm, "CMBlockBufferGetDataPointer")
		mxFn.cmBlockCopyDataBytes = mxSymbol(mx.cm, "CMBlockBufferCopyDataBytes")
		mxFn.cmH264ParamSet = mxSymbol(mx.cm, "CMVideoFormatDescriptionGetH264ParameterSetAtIndex")
		mxFn.cvPoolCreateBuffer = mxSymbol(mx.cv, "CVPixelBufferPoolCreatePixelBuffer")
		mxFn.cvBufferSetAttachment = mxSymbol(mx.cv, "CVBufferSetAttachment")
		mxFn.cvLockBase = mxSymbol(mx.cv, "CVPixelBufferLockBaseAddress")
		mxFn.cvUnlockBase = mxSymbol(mx.cv, "CVPixelBufferUnlockBaseAddress")
		mxFn.cvBaseAddress = mxSymbol(mx.cv, "CVPixelBufferGetBaseAddress")
		mxFn.cvBytesPerRow = mxSymbol(mx.cv, "CVPixelBufferGetBytesPerRow")
		mxFn.vtXferRun = mxSymbol(mx.vt, "VTPixelTransferSessionTransferImage")

		mx.cfTrue = mxConstant(mx.cf, "kCFBooleanTrue")
		mx.cfFalse = mxConstant(mx.cf, "kCFBooleanFalse")
		mx.cfArrCB = mxSymbol(mx.cf, "kCFTypeArrayCallBacks")
		reg(&mx.cfArrayCreate, mx.cf, "CFArrayCreate")
		mx.cfKeyCB = mxSymbol(mx.cf, "kCFTypeDictionaryKeyCallBacks")
		mx.cfValCB = mxSymbol(mx.cf, "kCFTypeDictionaryValueCallBacks")

		vtc := func(name string) uintptr { return mxConstant(mx.vt, name) }
		mx.kRealTime = vtc("kVTCompressionPropertyKey_RealTime")
		mx.kProfileLevel = vtc("kVTCompressionPropertyKey_ProfileLevel")
		mx.kReorder = vtc("kVTCompressionPropertyKey_AllowFrameReordering")
		mx.kAvgBitRate = vtc("kVTCompressionPropertyKey_AverageBitRate")
		mx.kMaxKeyInt = vtc("kVTCompressionPropertyKey_MaxKeyFrameInterval")
		mx.kMaxKeyDur = vtc("kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration")
		mx.kExpectedFPS = vtc("kVTCompressionPropertyKey_ExpectedFrameRate")
		mx.kPrioritize = vtc("kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality")
		mx.kDataRateLimits = vtc("kVTCompressionPropertyKey_DataRateLimits")
		mx.kUsingHW = vtc("kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder")
		mx.kForceKey = vtc("kVTEncodeFrameOptionKey_ForceKeyFrame")
		mx.kSpecEnableHW = vtc("kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder")
		mx.kSpecRequireHW = vtc("kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder")
		mx.vProfileCB = vtc("kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel")
		mx.vProfileHigh = vtc("kVTProfileLevel_H264_High_AutoLevel")
		mx.vProfileBase = vtc("kVTProfileLevel_H264_Baseline_AutoLevel")
		mx.vProfileMain = vtc("kVTProfileLevel_H264_Main_AutoLevel")
		mx.kMaxDelay = vtc("kVTCompressionPropertyKey_MaxFrameDelayCount")
		mx.kSessPrimaries = vtc("kVTCompressionPropertyKey_ColorPrimaries")
		mx.kSessTransfer = vtc("kVTCompressionPropertyKey_TransferFunction")
		mx.kSessMatrix = vtc("kVTCompressionPropertyKey_YCbCrMatrix")
		mx.kXferPrimaries = vtc("kVTPixelTransferPropertyKey_DestinationColorPrimaries")
		mx.kXferTransfer = vtc("kVTPixelTransferPropertyKey_DestinationTransferFunction")
		mx.kXferMatrix = vtc("kVTPixelTransferPropertyKey_DestinationYCbCrMatrix")
		mx.kXferRealTime = vtc("kVTPixelTransferPropertyKey_RealTime")
		mx.kNotSync = mxConstant(mx.cm, "kCMSampleAttachmentKey_NotSync")
		cvc := func(name string) uintptr { return mxConstant(mx.cv, name) }
		mx.kPBFormat = cvc("kCVPixelBufferPixelFormatTypeKey")
		mx.kPBWidth = cvc("kCVPixelBufferWidthKey")
		mx.kPBHeight = cvc("kCVPixelBufferHeightKey")
		mx.kPBIOSurface = cvc("kCVPixelBufferIOSurfacePropertiesKey")
		mx.kSRGB = mxConstant(mxFramework("CoreGraphics"), "kCGColorSpaceSRGB")
		mx.kPrimaries = cvc("kCVImageBufferColorPrimariesKey")
		mx.kTransfer = cvc("kCVImageBufferTransferFunctionKey")
		mx.kMatrix = cvc("kCVImageBufferYCbCrMatrixKey")
		mx.vPrim709 = cvc("kCVImageBufferColorPrimaries_ITU_R_709_2")
		mx.vPrim601 = cvc("kCVImageBufferColorPrimaries_SMPTE_C")
		mx.vTransfer709 = cvc("kCVImageBufferTransferFunction_ITU_R_709_2")
		mx.vMat709 = cvc("kCVImageBufferYCbCrMatrix_ITU_R_709_2")
		mx.vMat601 = cvc("kCVImageBufferYCbCrMatrix_ITU_R_601_4")
	})
	return mx.err
}

func mxBytes(p uintptr, n int) []byte {
	return unsafe.Slice(*(**byte)(unsafe.Pointer(&p)), n)
}

func mxInt32(v int32) uintptr {
	return mx.cfNumberCreate(0, mxNumSInt32, unsafe.Pointer(&v))
}

func mxFloat64(v float64) uintptr {
	return mx.cfNumberCreate(0, mxNumFloat64, unsafe.Pointer(&v))
}

// mxDict builds a CFDictionary of CF objects; the caller releases it.
func mxDict(kv ...uintptr) uintptr {
	n := len(kv) / 2
	keys, vals := make([]uintptr, n+1), make([]uintptr, n+1)
	for i := 0; i < n; i++ {
		keys[i], vals[i] = kv[2*i], kv[2*i+1]
	}
	return mx.cfDictionaryCreate(0, &keys[0], &vals[0], n, mx.cfKeyCB, mx.cfValCB)
}

func mxStatus(what string, st int32) error {
	if st == 0 {
		return nil
	}
	return fmt.Errorf("%s: OSStatus %d", what, st)
}
