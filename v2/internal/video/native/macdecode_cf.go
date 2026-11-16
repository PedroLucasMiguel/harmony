//go:build darwin

// Bindings to the parts of CoreFoundation, CoreMedia, CoreVideo and VideoToolbox the decoder uses, called without cgo.
package native

import (
	"fmt"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	mdecCF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
	mdecCM = "/System/Library/Frameworks/CoreMedia.framework/CoreMedia"
	mdecCV = "/System/Library/Frameworks/CoreVideo.framework/CoreVideo"
	mdecVT = "/System/Library/Frameworks/VideoToolbox.framework/VideoToolbox"
)

const (
	mdecNumberSInt32 = 3
	mdecAvc1         = 0x61766331
	mdecRGBA         = 0x52474241
	mdecBGRA         = 0x42475241
)

// mdecAPI holds function addresses and the values of exported constants.
type mdecAPI struct {
	cfRelease, cfRetain, cfNumberCreate, cfDictCreate, cfDictMutableCopy, cfDictSet, cfDictGet uintptr

	cmFmtFromH264, cmFmtCreate, cmFmtExtensions, cmBlockCreate, cmBlockReplace, cmSbufReady uintptr

	cvLock, cvUnlock, cvBase, cvBytesPerRow, cvWidth, cvHeight, cvIOSurface uintptr

	vtCreate, vtDecode, vtInvalidate, vtWait, vtCanAccept, vtSetProperty uintptr

	keyCallbacks, valueCallbacks uintptr

	boolTrue, boolFalse, specHardware             uintptr
	pixelFormatKey, pixelWidthKey, pixelHeightKey uintptr
	ioSurfaceKey, openGLKey                       uintptr
	extMatrix, extFull, extPrimaries, extTransfer uintptr
	primaries709, transfer709                     uintptr
	matrix709, matrix601, matrix2020, matrix240   uintptr
	vtRealTime                                    uintptr
}

var (
	mdecOnce sync.Once
	mdecLib  mdecAPI
	mdecErr  error
)

func mdecLoad() (*mdecAPI, error) {
	mdecOnce.Do(func() { mdecErr = mdecLib.load() })
	return &mdecLib, mdecErr
}

func (a *mdecAPI) load() error {
	var missing string
	open := func(path string) uintptr {
		h, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil && missing == "" {
			missing = err.Error()
		}
		return h
	}
	cf, cm, cv, vt := open(mdecCF), open(mdecCM), open(mdecCV), open(mdecVT)
	if missing != "" {
		return fmt.Errorf("video framework: %s", missing)
	}
	fn := func(lib uintptr, name string) uintptr {
		p, err := purego.Dlsym(lib, name)
		if err != nil && missing == "" {
			missing = err.Error()
		}
		return p
	}
	val := func(lib uintptr, name string) uintptr { return mdecDeref(fn(lib, name)) }

	a.cfRelease, a.cfRetain = fn(cf, "CFRelease"), fn(cf, "CFRetain")
	a.cfNumberCreate, a.cfDictCreate = fn(cf, "CFNumberCreate"), fn(cf, "CFDictionaryCreate")
	a.cfDictMutableCopy, a.cfDictSet, a.cfDictGet = fn(cf, "CFDictionaryCreateMutableCopy"), fn(cf, "CFDictionarySetValue"), fn(cf, "CFDictionaryGetValue")
	a.keyCallbacks, a.valueCallbacks = fn(cf, "kCFTypeDictionaryKeyCallBacks"), fn(cf, "kCFTypeDictionaryValueCallBacks")
	a.boolTrue, a.boolFalse = val(cf, "kCFBooleanTrue"), val(cf, "kCFBooleanFalse")

	a.cmFmtFromH264, a.cmFmtCreate = fn(cm, "CMVideoFormatDescriptionCreateFromH264ParameterSets"), fn(cm, "CMVideoFormatDescriptionCreate")
	a.cmFmtExtensions = fn(cm, "CMFormatDescriptionGetExtensions")
	a.cmBlockCreate, a.cmBlockReplace = fn(cm, "CMBlockBufferCreateWithMemoryBlock"), fn(cm, "CMBlockBufferReplaceDataBytes")
	a.cmSbufReady = fn(cm, "CMSampleBufferCreateReady")
	a.extMatrix, a.extFull = val(cm, "kCMFormatDescriptionExtension_YCbCrMatrix"), val(cm, "kCMFormatDescriptionExtension_FullRangeVideo")
	a.extPrimaries, a.extTransfer = val(cm, "kCMFormatDescriptionExtension_ColorPrimaries"), val(cm, "kCMFormatDescriptionExtension_TransferFunction")
	a.primaries709, a.transfer709 = val(cm, "kCMFormatDescriptionColorPrimaries_ITU_R_709_2"), val(cm, "kCMFormatDescriptionTransferFunction_ITU_R_709_2")
	a.matrix709, a.matrix601 = val(cm, "kCMFormatDescriptionYCbCrMatrix_ITU_R_709_2"), val(cm, "kCMFormatDescriptionYCbCrMatrix_ITU_R_601_4")
	a.matrix2020 = val(cm, "kCMFormatDescriptionYCbCrMatrix_ITU_R_2020")
	a.matrix240 = val(cm, "kCMFormatDescriptionYCbCrMatrix_SMPTE_240M_1995")

	a.cvLock, a.cvUnlock = fn(cv, "CVPixelBufferLockBaseAddress"), fn(cv, "CVPixelBufferUnlockBaseAddress")
	a.cvBase, a.cvBytesPerRow = fn(cv, "CVPixelBufferGetBaseAddress"), fn(cv, "CVPixelBufferGetBytesPerRow")
	a.cvWidth, a.cvHeight = fn(cv, "CVPixelBufferGetWidth"), fn(cv, "CVPixelBufferGetHeight")
	a.pixelFormatKey, a.pixelWidthKey, a.pixelHeightKey = val(cv, "kCVPixelBufferPixelFormatTypeKey"), val(cv, "kCVPixelBufferWidthKey"), val(cv, "kCVPixelBufferHeightKey")
	a.cvIOSurface = fn(cv, "CVPixelBufferGetIOSurface")
	a.ioSurfaceKey, a.openGLKey = val(cv, "kCVPixelBufferIOSurfacePropertiesKey"), val(cv, "kCVPixelBufferOpenGLCompatibilityKey")

	a.vtCreate, a.vtDecode = fn(vt, "VTDecompressionSessionCreate"), fn(vt, "VTDecompressionSessionDecodeFrame")
	a.vtInvalidate, a.vtWait = fn(vt, "VTDecompressionSessionInvalidate"), fn(vt, "VTDecompressionSessionWaitForAsynchronousFrames")
	a.vtCanAccept, a.vtSetProperty = fn(vt, "VTDecompressionSessionCanAcceptFormatDescription"), fn(vt, "VTSessionSetProperty")
	a.vtRealTime = val(vt, "kVTDecompressionPropertyKey_RealTime")
	a.specHardware = val(vt, "kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder")
	if missing != "" {
		return fmt.Errorf("video framework: %s", missing)
	}
	return nil
}

func mdecCall(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(fn, args...)
	return r
}

func mdecStatus(r uintptr) int32 { return int32(r) }

// mdecDeref reads the pointer-sized value at an address the system gave out.
func mdecDeref(addr uintptr) uintptr {
	return *(*uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(&addr)))
}

func mdecWords(addr uintptr, n int) []uint32 {
	return unsafe.Slice((*uint32)(*(*unsafe.Pointer)(unsafe.Pointer(&addr))), n)
}

func mdecPtr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

func (a *mdecAPI) release(obj uintptr) {
	if obj != 0 {
		mdecCall(a.cfRelease, obj)
	}
}
