package native

// The VA-API types and constants of libva (va.h, va_enc_h264.h) that the Linux decoder and encoder use, laid out as the
// C structs are on 64-bit Linux. Bit-field unions are plain uint32 values: the vaSeq... and vaPic... shifts below say
// where each field sits. Not tagged for Linux so that the layout tests run everywhere.

type (
	vaSurfaceID uint32
	vaConfigID  uint32
	vaContextID uint32
	vaBufferID  uint32
	vaImageID   uint32
)

const (
	vaInvalidID = 0xffffffff

	vaStatusSuccess = 0

	vaProfileH264Main                = 6
	vaProfileH264High                = 7
	vaProfileH264ConstrainedBaseline = 13

	vaEntrypointVLD        = 1
	vaEntrypointEncSlice   = 6
	vaEntrypointEncSliceLP = 8

	vaConfigAttribRTFormat         = 0
	vaConfigAttribRateControl      = 5
	vaConfigAttribEncPackedHeaders = 10
	vaConfigAttribEncMaxRefFrames  = 13
	vaConfigAttribMaxPictureWidth  = 18
	vaConfigAttribMaxPictureHeight = 19

	vaAttribNotSupported = 0x80000000

	vaRTFormatYUV420 = 0x1

	vaRCNone = 0x1
	vaRCCBR  = 0x2
	vaRCVBR  = 0x4
	vaRCCQP  = 0x10

	vaEncPackedHeaderSequence = 0x1
	vaEncPackedHeaderPicture  = 0x2
	vaEncPackedHeaderSlice    = 0x4
	vaEncPackedHeaderMisc     = 0x8
	vaEncPackedHeaderRawData  = 0x10

	vaFourccNV12 = 0x3231564e

	vaSurfaceAttribNone        = 0
	vaSurfaceAttribPixelFormat = 1
	vaSurfaceAttribMemoryType  = 6
	vaSurfaceAttribUsageHint   = 8
	vaSurfaceAttribSettable    = 0x2
	vaGenericValueInteger      = 1

	vaSurfaceMemTypeVA = 0x1

	vaSurfaceUsageDecoder = 0x1
	vaSurfaceUsageEncoder = 0x2

	vaProgressive = 0x1

	vaPictureParameterBufferType         = 0
	vaIQMatrixBufferType                 = 1
	vaSliceParameterBufferType           = 4
	vaSliceDataBufferType                = 5
	vaEncCodedBufferType                 = 21
	vaEncSequenceParameterBufferType     = 22
	vaEncPictureParameterBufferType      = 23
	vaEncSliceParameterBufferType        = 24
	vaEncPackedHeaderParameterBufferType = 25
	vaEncPackedHeaderDataBufferType      = 26
	vaEncMiscParameterBufferType         = 27

	vaEncMiscParameterTypeFrameRate   = 0
	vaEncMiscParameterTypeRateControl = 1
	vaEncMiscParameterTypeHRD         = 5

	vaPictureH264Invalid        = 0x1
	vaPictureH264ShortTermRef   = 0x8
	vaPictureH264LongTermRef    = 0x10
	vaPictureH264NonExisting    = 0x20
	vaSliceDataFlagAll          = 0
	vaCodedBufStatusSingleNALU  = 0x10000000
	vaCodedBufStatusSliceOverfl = 0x200
)

// Shifts of the bit fields of VAPictureParameterBufferH264.seq_fields and pic_fields (decode).
const (
	vaDecSeqChromaFormatIdc     = 0 // 2 bits
	vaDecSeqGapsInFrameNum      = 3
	vaDecSeqFrameMbsOnly        = 4
	vaDecSeqMbAdaptive          = 5
	vaDecSeqDirect8x8Inference  = 6
	vaDecSeqMinLumaBiPred       = 7
	vaDecSeqLog2MaxFrameNum     = 8  // 4 bits, minus 4
	vaDecSeqPocType             = 12 // 2 bits
	vaDecSeqLog2MaxPocLsb       = 14 // 4 bits, minus 4
	vaDecSeqDeltaPocAlwaysZero  = 18
	vaDecPicEntropyCoding       = 0
	vaDecPicWeightedPred        = 1
	vaDecPicWeightedBipredIdc   = 2 // 2 bits
	vaDecPicTransform8x8        = 4
	vaDecPicFieldPic            = 5
	vaDecPicConstrainedIntra    = 6
	vaDecPicOrderPresent        = 7
	vaDecPicDeblockingControl   = 8
	vaDecPicRedundantPicCnt     = 9
	vaDecPicReferencePic        = 10
	vaEncSeqChromaFormatIdc     = 0 // 2 bits
	vaEncSeqFrameMbsOnly        = 2
	vaEncSeqMbAdaptive          = 3
	vaEncSeqScalingMatrix       = 4
	vaEncSeqDirect8x8Inference  = 5
	vaEncSeqLog2MaxFrameNum     = 6  // 4 bits, minus 4
	vaEncSeqPocType             = 10 // 2 bits
	vaEncSeqLog2MaxPocLsb       = 12 // 4 bits, minus 4
	vaEncSeqDeltaPocAlwaysZero  = 16
	vaEncVuiAspectRatioPresent  = 0
	vaEncVuiTimingInfoPresent   = 1
	vaEncVuiBitstreamRestrict   = 2
	vaEncVuiLog2MaxMvLenH       = 3 // 5 bits
	vaEncVuiLog2MaxMvLenV       = 8 // 5 bits
	vaEncVuiFixedFrameRate      = 13
	vaEncVuiLowDelayHrd         = 14
	vaEncVuiMvOverPicBoundaries = 15
	vaEncPicIdr                 = 0
	vaEncPicReferencePic        = 1 // 2 bits
	vaEncPicEntropyCoding       = 3
	vaEncPicWeightedPred        = 4
	vaEncPicWeightedBipredIdc   = 5 // 2 bits
	vaEncPicConstrainedIntra    = 7
	vaEncPicTransform8x8        = 8
	vaEncPicDeblockingControl   = 9
	vaEncPicRedundantPicCnt     = 10
	vaEncPicOrderPresent        = 11
	vaEncPicScalingMatrix       = 12
	vaRCFlagReset               = 0
	vaRCFlagDisableFrameSkip    = 1
	vaRCFlagDisableBitStuffing  = 2
	vaRCFlagMbRateControl       = 3 // 4 bits
	vaRCFlagTemporalID          = 7 // 8 bits
)

type vaConfigAttrib struct {
	Type  int32
	Value uint32
}

// vaGenericValue is VAGenericValue: a type and a union of 4 and 8 byte members.
type vaGenericValue struct {
	Type  int32
	_     int32
	Value uint64
}

type vaSurfaceAttrib struct {
	Type  int32
	Flags uint32
	Value vaGenericValue
}

func vaIntAttrib(typ int32, v int) vaSurfaceAttrib {
	return vaSurfaceAttrib{Type: typ, Flags: vaSurfaceAttribSettable, Value: vaGenericValue{Type: vaGenericValueInteger, Value: uint64(uint32(v))}}
}

type vaPictureH264 struct {
	PictureID           vaSurfaceID
	FrameIdx            uint32
	Flags               uint32
	TopFieldOrderCnt    int32
	BottomFieldOrderCnt int32
	_                   [4]uint32
}

func vaInvalidPicture() vaPictureH264 {
	return vaPictureH264{PictureID: vaInvalidID, Flags: vaPictureH264Invalid}
}

type vaPictureParameterBufferH264 struct {
	CurrPic                    vaPictureH264
	ReferenceFrames            [16]vaPictureH264
	PictureWidthInMbsMinus1    uint16
	PictureHeightInMbsMinus1   uint16
	BitDepthLumaMinus8         uint8
	BitDepthChromaMinus8       uint8
	NumRefFrames               uint8
	SeqFields                  uint32
	NumSliceGroupsMinus1       uint8
	SliceGroupMapType          uint8
	SliceGroupChangeRateMinus1 uint16
	PicInitQpMinus26           int8
	PicInitQsMinus26           int8
	ChromaQpIndexOffset        int8
	SecondChromaQpIndexOffset  int8
	PicFields                  uint32
	FrameNum                   uint16
	_                          [8]uint32
}

type vaIQMatrixBufferH264 struct {
	ScalingList4x4 [6][16]uint8
	ScalingList8x8 [2][64]uint8
	_              [4]uint32
}

type vaSliceParameterBufferH264 struct {
	SliceDataSize             uint32
	SliceDataOffset           uint32
	SliceDataFlag             uint32
	SliceDataBitOffset        uint16
	FirstMbInSlice            uint16
	SliceType                 uint8
	DirectSpatialMvPredFlag   uint8
	NumRefIdxL0ActiveMinus1   uint8
	NumRefIdxL1ActiveMinus1   uint8
	CabacInitIdc              uint8
	SliceQpDelta              int8
	DisableDeblockingFilterID uint8
	SliceAlphaC0Offset        int8
	SliceBetaOffset           int8
	RefPicList0               [32]vaPictureH264
	RefPicList1               [32]vaPictureH264
	LumaLog2WeightDenom       uint8
	ChromaLog2WeightDenom     uint8
	LumaWeightL0Flag          uint8
	LumaWeightL0              [32]int16
	LumaOffsetL0              [32]int16
	ChromaWeightL0Flag        uint8
	ChromaWeightL0            [32][2]int16
	ChromaOffsetL0            [32][2]int16
	LumaWeightL1Flag          uint8
	LumaWeightL1              [32]int16
	LumaOffsetL1              [32]int16
	ChromaWeightL1Flag        uint8
	ChromaWeightL1            [32][2]int16
	ChromaOffsetL1            [32][2]int16
	_                         [4]uint32
}

type vaImageFormat struct {
	Fourcc       uint32
	ByteOrder    uint32
	BitsPerPixel uint32
	Depth        uint32
	RedMask      uint32
	GreenMask    uint32
	BlueMask     uint32
	AlphaMask    uint32
	_            [4]uint32
}

type vaImage struct {
	ImageID           vaImageID
	Format            vaImageFormat
	Buf               vaBufferID
	Width             uint16
	Height            uint16
	DataSize          uint32
	NumPlanes         uint32
	Pitches           [3]uint32
	Offsets           [3]uint32
	NumPaletteEntries int32
	EntryBytes        int32
	ComponentOrder    [4]int8
	_                 [4]uint32
}

// vaCodedBufferSegment is VACodedBufferSegment, a node of the list a mapped coded buffer holds.
type vaCodedBufferSegment struct {
	Size      uint32
	BitOffset uint32
	Status    uint32
	Reserved  uint32
	Buf       uintptr
	Next      uintptr
	_         [4]uint32
}

type vaEncPackedHeaderParameterBuffer struct {
	Type              uint32
	BitLength         uint32
	HasEmulationBytes uint8
	_                 [4]uint32
}

// vaEncMiscParameterBuffer is the header VAEncMiscParameterBuffer: a type, then the payload of that type follows at once
// in the same buffer.
type vaEncMiscParameterBuffer struct {
	Type uint32
}

type vaEncMiscParameterRateControl struct {
	BitsPerSecond    uint32
	TargetPercentage uint32
	WindowSize       uint32
	InitialQp        uint32
	MinQp            uint32
	BasicUnitSize    uint32
	RCFlags          uint32
	ICQQualityFactor uint32
	MaxQp            uint32
	QualityFactor    uint32
	TargetFrameSize  uint32
	_                [4]uint32
}

type vaEncMiscParameterFrameRate struct {
	Framerate      uint32
	FramerateFlags uint32
	_              [4]uint32
}

type vaEncMiscParameterHRD struct {
	InitialBufferFullness uint32
	BufferSize            uint32
	_                     [4]uint32
}

// vaEncMiscRateControl, vaEncMiscFrameRate and vaEncMiscHRD are a whole misc parameter buffer: header and payload.
type vaEncMiscRateControl struct {
	vaEncMiscParameterBuffer
	vaEncMiscParameterRateControl
}

type vaEncMiscFrameRate struct {
	vaEncMiscParameterBuffer
	vaEncMiscParameterFrameRate
}

type vaEncMiscHRD struct {
	vaEncMiscParameterBuffer
	vaEncMiscParameterHRD
}

type vaEncSequenceParameterBufferH264 struct {
	SeqParameterSetID              uint8
	LevelIdc                       uint8
	IntraPeriod                    uint32
	IntraIdrPeriod                 uint32
	IpPeriod                       uint32
	BitsPerSecond                  uint32
	MaxNumRefFrames                uint32
	PictureWidthInMbs              uint16
	PictureHeightInMbs             uint16
	SeqFields                      uint32
	BitDepthLumaMinus8             uint8
	BitDepthChromaMinus8           uint8
	NumRefFramesInPicOrderCntCycle uint8
	OffsetForNonRefPic             int32
	OffsetForTopToBottomField      int32
	OffsetForRefFrame              [256]int32
	FrameCroppingFlag              uint8
	FrameCropLeftOffset            uint32
	FrameCropRightOffset           uint32
	FrameCropTopOffset             uint32
	FrameCropBottomOffset          uint32
	VuiParametersPresentFlag       uint8
	VuiFields                      uint32
	AspectRatioIdc                 uint8
	SarWidth                       uint32
	SarHeight                      uint32
	NumUnitsInTick                 uint32
	TimeScale                      uint32
	_                              [4]uint32
}

type vaEncPictureParameterBufferH264 struct {
	CurrPic                   vaPictureH264
	ReferenceFrames           [16]vaPictureH264
	CodedBuf                  vaBufferID
	PicParameterSetID         uint8
	SeqParameterSetID         uint8
	LastPicture               uint8
	FrameNum                  uint16
	PicInitQp                 uint8
	NumRefIdxL0ActiveMinus1   uint8
	NumRefIdxL1ActiveMinus1   uint8
	ChromaQpIndexOffset       int8
	SecondChromaQpIndexOffset int8
	PicFields                 uint32
	_                         [4]uint32
}

type vaEncSliceParameterBufferH264 struct {
	MacroblockAddress           uint32
	NumMacroblocks              uint32
	MacroblockInfo              vaBufferID
	SliceType                   uint8
	PicParameterSetID           uint8
	IdrPicID                    uint16
	PicOrderCntLsb              uint16
	DeltaPicOrderCntBottom      int32
	DeltaPicOrderCnt            [2]int32
	DirectSpatialMvPredFlag     uint8
	NumRefIdxActiveOverrideFlag uint8
	NumRefIdxL0ActiveMinus1     uint8
	NumRefIdxL1ActiveMinus1     uint8
	RefPicList0                 [32]vaPictureH264
	RefPicList1                 [32]vaPictureH264
	LumaLog2WeightDenom         uint8
	ChromaLog2WeightDenom       uint8
	LumaWeightL0Flag            uint8
	LumaWeightL0                [32]int16
	LumaOffsetL0                [32]int16
	ChromaWeightL0Flag          uint8
	ChromaWeightL0              [32][2]int16
	ChromaOffsetL0              [32][2]int16
	LumaWeightL1Flag            uint8
	LumaWeightL1                [32]int16
	LumaOffsetL1                [32]int16
	ChromaWeightL1Flag          uint8
	ChromaWeightL1              [32][2]int16
	ChromaOffsetL1              [32][2]int16
	CabacInitIdc                uint8
	SliceQpDelta                int8
	DisableDeblockingFilterIdc  uint8
	SliceAlphaC0OffsetDiv2      int8
	SliceBetaOffsetDiv2         int8
	_                           [4]uint32
}
