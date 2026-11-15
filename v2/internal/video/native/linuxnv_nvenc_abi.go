//go:build linux

// The NVENC structures this client fills in, laid out as in nvEncodeAPI.h of Video Codec SDK 11.1 (the oldest API that has
// the P1 to P7 presets and tuning info, so it runs on every driver from 470 on; a newer driver still accepts it). Each
// struct is padded to the size the header gives it, because the driver checks the version number and reads the whole
// size. linuxnv_abi_test.go asserts every size and offset against the C compiler's.
package native

// nvEncAPIVersion is NVENCAPI_VERSION: major 11 in the low byte, minor 1 above bit 24.
const nvEncAPIVersion = 11 | 1<<24

// nvEncStructVersion is NVENCAPI_STRUCT_VERSION(v).
func nvEncStructVersion(v uint32) uint32 { return nvEncAPIVersion | v<<16 | 0x7<<28 }

// nvEncStructVersionExt is the same with the extra bit 31 that the larger structures carry.
func nvEncStructVersionExt(v uint32) uint32 { return nvEncStructVersion(v) | 1<<31 }

var (
	nvEncFunctionListVer    = nvEncStructVersion(2)
	nvEncOpenSessionVer     = nvEncStructVersion(1)
	nvEncCapsParamVer       = nvEncStructVersion(1)
	nvEncConfigVer          = nvEncStructVersionExt(7)
	nvEncInitParamsVer      = nvEncStructVersionExt(5)
	nvEncPresetConfigVer    = nvEncStructVersionExt(4)
	nvEncPicParamsVer       = nvEncStructVersionExt(4)
	nvEncCreateInputVer     = nvEncStructVersion(1)
	nvEncCreateBitstreamVer = nvEncStructVersion(1)
	nvEncLockBitstreamVer   = nvEncStructVersion(1)
	nvEncLockInputVer       = nvEncStructVersion(1)
	nvEncRCParamsVer        = nvEncStructVersion(1)
)

const (
	nvEncSuccess        = 0
	nvEncNeedMoreInput  = 17
	nvEncDeviceCUDA     = 1
	nvEncBufferNV12     = 0x1
	nvEncPicStructFrame = 1
	nvEncRCCBR          = 2
	nvEncTuningUltraLow = 3

	nvEncPicFlagForceIDR   = 0x2
	nvEncPicFlagOutputSPPS = 0x4

	nvEncCapWidthMax  = 16
	nvEncCapHeightMax = 17

	// repeatSPSPPS is bit 12 of the H.264 configuration's bit field: enableTemporalSVC is bit 0 and they follow in order.
	nvEncH264RepeatSPSPPS = 1 << 12
	// zeroReorderDelay is bit 9 of the rate control bit field: enableMinQP is bit 0.
	nvEncRCZeroReorderDelay = 1 << 9

	nvEncEntropyCAVLC = 2
)

// nvGUID is a GUID as the header declares it: 4, 2, 2 and 8 bytes.
type nvGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// words is the GUID as the two 64 bit halves in which the C calling convention passes a 16 byte structure by value.
func (g nvGUID) words() (lo, hi uintptr) {
	lo = uintptr(g.Data1) | uintptr(g.Data2)<<32 | uintptr(g.Data3)<<48
	for i := 7; i >= 0; i-- {
		hi = hi<<8 | uintptr(g.Data4[i])
	}
	return lo, hi
}

var (
	nvEncCodecH264   = nvGUID{0x6bc82762, 0x4e63, 0x4ca4, [8]byte{0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf}}
	nvEncProfileHigh = nvGUID{0xe7cbc309, 0x4f7a, 0x4b89, [8]byte{0xaf, 0x2a, 0xd5, 0x37, 0xc9, 0x2b, 0xe3, 0x10}}
	nvEncProfileBase = nvGUID{0x727bcaa, 0x78c4, 0x4c83, [8]byte{0x8c, 0x2f, 0xef, 0x3d, 0xff, 0x26, 0x7c, 0x6a}}
	nvEncProfileMain = nvGUID{0x60b5c1d4, 0x67fe, 0x4790, [8]byte{0x94, 0xd5, 0xc4, 0x72, 0x6d, 0x7b, 0x6e, 0x6d}}
	nvEncPresetP3    = nvGUID{0x36850110, 0x3a07, 0x441f, [8]byte{0x94, 0xd5, 0x36, 0x70, 0x63, 0x1f, 0x91, 0xf6}}
)

type nvEncRCParams struct {
	version         uint32
	rateControlMode uint32
	constQP         [3]uint32
	averageBitRate  uint32
	maxBitRate      uint32
	vbvBufferSize   uint32
	vbvInitialDelay uint32
	flags           uint32
	minQP           [3]uint32
	maxQP           [3]uint32
	initialRCQP     [3]uint32
	temporalIdxMask uint32
	temporalLayerQP [8]uint8
	targetQuality   uint8
	targetQualityLS uint8
	lookaheadDepth  uint16
	lowDelayKeyScal uint8
	reserved1       [3]uint8
	qpMapMode       uint32
	multiPass       uint32
	alphaLayerRatio uint32
	cbQPIndexOffset int8
	crQPIndexOffset int8
	reserved2       uint16
	reserved        [4]uint32
}

type nvEncH264VUI struct {
	overscanInfoPresent      uint32
	overscanInfo             uint32
	videoSignalTypePresent   uint32
	videoFormat              uint32
	videoFullRange           uint32
	colourDescriptionPresent uint32
	colourPrimaries          uint32
	transferCharacteristics  uint32
	colourMatrix             uint32
	chromaSampleLocationFlag uint32
	chromaSampleLocationTop  uint32
	chromaSampleLocationBot  uint32
	bitstreamRestrictionFlag uint32
	reserved                 [15]uint32
}

type nvEncH264Config struct {
	flags                uint32
	level                uint32
	idrPeriod            uint32
	separateColourPlane  uint32
	disableDeblockingIDC uint32
	numTemporalLayers    uint32
	spsID                uint32
	ppsID                uint32
	adaptiveTransform    uint32
	fmoMode              uint32
	bdirectMode          uint32
	entropyCodingMode    uint32
	stereoMode           uint32
	intraRefreshPeriod   uint32
	intraRefreshCnt      uint32
	maxNumRefFrames      uint32
	sliceMode            uint32
	sliceModeData        uint32
	vui                  nvEncH264VUI
	ltrNumFrames         uint32
	ltrTrustMode         uint32
	chromaFormatIDC      uint32
	maxTemporalLayers    uint32
	useBFramesAsRef      uint32
	numRefL0             uint32
	numRefL1             uint32
	reserved1            [267]uint32
	reserved2            [64]uintptr
}

// nvEncConfig is NV_ENC_CONFIG with the codec union holding the H.264 member, which is as large as the union.
type nvEncConfig struct {
	version        uint32
	profileGUID    nvGUID
	gopLength      uint32
	frameIntervalP int32
	monoChrome     uint32
	frameFieldMode uint32
	mvPrecision    uint32
	rc             nvEncRCParams
	h264           nvEncH264Config
	reserved       [278]uint32
	reserved2      [64]uintptr
}

type nvEncInitParams struct {
	version           uint32
	encodeGUID        nvGUID
	presetGUID        nvGUID
	encodeWidth       uint32
	encodeHeight      uint32
	darWidth          uint32
	darHeight         uint32
	frameRateNum      uint32
	frameRateDen      uint32
	enableEncodeAsync uint32
	enablePTD         uint32
	flags             uint32
	privDataSize      uint32
	privData          uintptr
	encodeConfig      uintptr
	maxEncodeWidth    uint32
	maxEncodeHeight   uint32
	maxMEHintCounts   [8]uint32
	tuningInfo        uint32
	bufferFormat      uint32
	reserved          [287]uint32
	reserved2         [64]uintptr
}

type nvEncPresetConfig struct {
	version   uint32
	preset    nvEncConfig
	reserved1 [255]uint32
	reserved2 [64]uintptr
}

type nvEncPicParams struct {
	version         uint32
	inputWidth      uint32
	inputHeight     uint32
	inputPitch      uint32
	encodePicFlags  uint32
	frameIdx        uint32
	inputTimeStamp  uint64
	inputDuration   uint64
	inputBuffer     uintptr
	outputBitstream uintptr
	completionEvent uintptr
	bufferFmt       uint32
	pictureStruct   uint32
	pictureType     uint32
	codecPicParams  [192]uint64
	_               [3344 - 1616]byte
}

type nvEncLockBitstream struct {
	version              uint32
	flags                uint32
	outputBitstream      uintptr
	sliceOffsets         uintptr
	frameIdx             uint32
	hwEncodeStatus       uint32
	numSlices            uint32
	bitstreamSizeInBytes uint32
	outputTimeStamp      uint64
	outputDuration       uint64
	bitstreamBufferPtr   uintptr
	pictureType          uint32
	pictureStruct        uint32
	_                    [1544 - 72]byte
}

type nvEncLockInput struct {
	version       uint32
	flags         uint32
	inputBuffer   uintptr
	bufferDataPtr uintptr
	pitch         uint32
	_             [1544 - 28]byte
}

type nvEncCreateInput struct {
	version       uint32
	width         uint32
	height        uint32
	memoryHeap    uint32
	bufferFmt     uint32
	reserved      uint32
	inputBuffer   uintptr
	pSysMemBuffer uintptr
	_             [776 - 40]byte
}

type nvEncCreateBitstream struct {
	version            uint32
	size               uint32
	memoryHeap         uint32
	reserved           uint32
	bitstreamBuffer    uintptr
	bitstreamBufferPtr uintptr
	_                  [776 - 32]byte
}

type nvEncCapsParam struct {
	version     uint32
	capsToQuery uint32
	reserved    [62]uint32
}

type nvEncOpenSession struct {
	version    uint32
	deviceType uint32
	device     uintptr
	reserved   uintptr
	apiVersion uint32
	reserved1  [253]uint32
	reserved2  [64]uintptr
}

// nvEncFunctions is NV_ENCODE_API_FUNCTION_LIST: the entry points NvEncodeAPICreateInstance fills in, in the header's order
// (the profile GUID entries come before GetEncodeGUIDs there).
type nvEncFunctions struct {
	version                   uint32
	reserved                  uint32
	openEncodeSession         uintptr
	getEncodeGUIDCount        uintptr
	getEncodeProfileGUIDCount uintptr
	getEncodeProfileGUIDs     uintptr
	getEncodeGUIDs            uintptr
	getInputFormatCount       uintptr
	getInputFormats           uintptr
	getEncodeCaps             uintptr
	getEncodePresetCount      uintptr
	getEncodePresetGUIDs      uintptr
	getEncodePresetConfig     uintptr
	initializeEncoder         uintptr
	createInputBuffer         uintptr
	destroyInputBuffer        uintptr
	createBitstreamBuffer     uintptr
	destroyBitstreamBuffer    uintptr
	encodePicture             uintptr
	lockBitstream             uintptr
	unlockBitstream           uintptr
	lockInputBuffer           uintptr
	unlockInputBuffer         uintptr
	getEncodeStats            uintptr
	getSequenceParams         uintptr
	registerAsyncEvent        uintptr
	unregisterAsyncEvent      uintptr
	mapInputResource          uintptr
	unmapInputResource        uintptr
	destroyEncoder            uintptr
	invalidateRefFrames       uintptr
	openEncodeSessionEx       uintptr
	registerResource          uintptr
	unregisterResource        uintptr
	reconfigureEncoder        uintptr
	reserved1                 uintptr
	createMVBuffer            uintptr
	destroyMVBuffer           uintptr
	runMotionEstimationOnly   uintptr
	getLastErrorString        uintptr
	setIOCudaStreams          uintptr
	getEncodePresetConfigEx   uintptr
	getSequenceParamEx        uintptr
	reserved2                 [277]uintptr
}

var nvEncStatusNames = [...]string{"success", "no encode device", "unsupported device", "invalid encoder device",
	"invalid device", "device does not exist", "invalid pointer", "invalid event", "invalid parameter", "invalid call",
	"out of memory", "encoder not initialized", "unsupported parameter", "lock busy", "not enough buffer", "invalid version",
	"map failed", "need more input", "encoder busy", "event not registered", "generic error", "incompatible client key",
	"unimplemented", "resource register failed", "resource not registered", "resource not mapped"}

func nvEncStatusName(st uint32) string {
	if int(st) < len(nvEncStatusNames) {
		return nvEncStatusNames[st]
	}
	return "unknown error"
}
