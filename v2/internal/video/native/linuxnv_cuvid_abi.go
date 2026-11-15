//go:build linux

// The NVDEC structures this client reads and fills in, laid out as in nvcuvid.h and cuviddec.h (Video Codec SDK 11.1; the
// layouts of these have not changed since). tcu_ulong is the C unsigned long, 8 bytes on 64 bit Linux. linuxnv_abi_test.go
// asserts every size and offset against the C compiler's.
package native

const (
	cuvidCodecH264         = 4
	cuvidChroma420         = 1
	cuvidSurfaceNV12       = 0
	cuvidCreatePreferCUVID = 4

	cuvidPktTimestamp    = 0x2
	cuvidPktEndOfPicture = 0x8
)

type cuvidDecodeCaps struct {
	codecType        uint32
	chromaFormat     uint32
	bitDepthMinus8   uint32
	reserved1        [3]uint32
	isSupported      uint8
	numNVDECs        uint8
	outputFormatMask uint16
	maxWidth         uint32
	maxHeight        uint32
	maxMBCount       uint32
	minWidth         uint16
	minHeight        uint16
	isHistogramSupp  uint8
	counterBitDepth  uint8
	maxHistogramBins uint16
	reserved3        [10]uint32
}

type cuvidRect struct{ left, top, right, bottom int16 }

type cuvidCreateInfo struct {
	width             uint64
	height            uint64
	numDecodeSurfaces uint64
	codecType         uint32
	chromaFormat      uint32
	creationFlags     uint64
	bitDepthMinus8    uint64
	intraDecodeOnly   uint64
	maxWidth          uint64
	maxHeight         uint64
	reserved1         uint64
	displayArea       cuvidRect
	outputFormat      uint32
	deinterlaceMode   uint32
	targetWidth       uint64
	targetHeight      uint64
	numOutputSurfaces uint64
	vidLock           uintptr
	targetRect        cuvidRect
	enableHistogram   uint64
	reserved2         [4]uint64
}

// cuvidVideoFormat is CUVIDEOFORMAT, what the parser tells the sequence callback about the stream. signal holds
// video_format in its low three bits and video_full_range_flag in the next.
type cuvidVideoFormat struct {
	codec                uint32
	frameRateNum         uint32
	frameRateDen         uint32
	progressive          uint8
	bitDepthLumaMinus8   uint8
	bitDepthChromaMinus8 uint8
	minNumDecodeSurfaces uint8
	codedWidth           uint32
	codedHeight          uint32
	displayArea          [4]int32
	chromaFormat         uint32
	bitrate              uint32
	displayAspect        [2]int32
	signal               uint8
	colourPrimaries      uint8
	transfer             uint8
	matrix               uint8
	seqHdrDataLength     uint32
}

func (f *cuvidVideoFormat) fullRange() bool { return f.signal&8 != 0 }

type cuvidDispInfo struct {
	pictureIndex     int32
	progressiveFrame int32
	topFieldFirst    int32
	repeatFirstField int32
	timestamp        int64
}

type cuvidParserParams struct {
	codecType        uint32
	maxNumDecodeSurf uint32
	clockRate        uint32
	errorThreshold   uint32
	maxDisplayDelay  uint32
	flags            uint32
	reserved1        [4]uint32
	userData         uintptr
	sequenceCallback uintptr
	decodeCallback   uintptr
	displayCallback  uintptr
	operatingPointCb uintptr
	reserved2        [6]uintptr
	extVideoInfo     uintptr
}

type cuvidSourcePacket struct {
	flags       uint64
	payloadSize uint64
	payload     uintptr
	timestamp   int64
}

type cuvidProcParams struct {
	progressiveFrame int32
	secondField      int32
	topFieldFirst    int32
	unpairedField    int32
	reservedFlags    uint32
	reservedZero     uint32
	rawInputDptr     uint64
	rawInputPitch    uint32
	rawInputFormat   uint32
	rawOutputDptr    uint64
	rawOutputPitch   uint32
	reserved1        uint32
	outputStream     uintptr
	reserved         [46]uint32
	histogramDptr    uintptr
	reserved2        [1]uintptr
}

// cudaMemcpy2D is CUDA_MEMCPY2D.
type cudaMemcpy2D struct {
	srcXInBytes   uint64
	srcY          uint64
	srcMemoryType uint32
	srcHost       uintptr
	srcDevice     uint64
	srcArray      uintptr
	srcPitch      uint64
	dstXInBytes   uint64
	dstY          uint64
	dstMemoryType uint32
	dstHost       uintptr
	dstDevice     uint64
	dstArray      uintptr
	dstPitch      uint64
	widthInBytes  uint64
	height        uint64
}
