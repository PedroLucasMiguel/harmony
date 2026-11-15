package native

// The V4L2 structs and ioctl numbers (linux/videodev2.h) on 64-bit Linux. Not tagged for Linux so that the layout test runs
// everywhere.

import "unsafe"

const (
	v4l2BufTypeVideoCapture = 1
	v4l2MemoryMMap          = 1
	v4l2FieldNone           = 1
	v4l2CapVideoCapture     = 0x1
	v4l2CapStreaming        = 0x04000000
	v4l2CapDeviceCaps       = 0x80000000
	v4l2BufFlagError        = 0x40
	v4l2FrmSizeDiscrete     = 1
	v4l2FrmIvalDiscrete     = 1
)

type v4l2Capability struct {
	Driver       [16]byte
	Card         [32]byte
	BusInfo      [32]byte
	Version      uint32
	Capabilities uint32
	DeviceCaps   uint32
	Reserved     [3]uint32
}

type v4l2PixFormat struct {
	Width, Height, PixelFormat, Field, BytesPerLine, SizeImage uint32
	Colorspace, Priv, Flags, YcbcrEnc, Quantization, XferFunc  uint32
}

// v4l2Format has its union at offset 8 because one of the union's members holds pointers.
type v4l2Format struct {
	Type uint32
	_    uint32
	Pix  v4l2PixFormat
	_    [200 - unsafe.Sizeof(v4l2PixFormat{})]byte
}

type v4l2FmtDesc struct {
	Index, Type, Flags uint32
	Description        [32]byte
	PixelFormat        uint32
	MbusCode           uint32
	Reserved           [3]uint32
}

type v4l2RequestBuffers struct {
	Count, Type, Memory, Capabilities uint32
	Flags                             uint8
	Reserved                          [3]uint8
}

type v4l2Buffer struct {
	Index, Type, BytesUsed, Flags, Field uint32
	_                                    uint32
	TimestampSec, TimestampUsec          int64
	TimecodeType, TimecodeFlags          uint32
	Timecode                             [4]uint8
	Userbits                             [4]uint8
	Sequence, Memory                     uint32
	Offset                               uint32
	_                                    uint32
	Length, Reserved2, RequestFD         uint32
	_                                    uint32
}

type v4l2StreamParm struct {
	Type uint32
	// Capture is v4l2_captureparm: capability, capturemode, timeperframe (numerator, denominator), extendedmode,
	// readbuffers, reserved[4].
	Capability, CaptureMode, Numerator, Denominator, ExtendedMode, ReadBuffers uint32
	Reserved                                                                   [4]uint32
	_                                                                          [200 - 40]byte
}

// v4l2FrmSizeEnum.Union holds a discrete size (width, height) or the six numbers of a stepwise range.
type v4l2FrmSizeEnum struct {
	Index, PixelFormat, Type uint32
	Union                    [6]uint32
	Reserved                 [2]uint32
}

// v4l2FrmIvalEnum.Union holds a discrete interval (numerator, denominator) or three fractions of a stepwise range.
type v4l2FrmIvalEnum struct {
	Index, PixelFormat, Width, Height, Type uint32
	Union                                   [6]uint32
	Reserved                                [2]uint32
}

// ioctl request numbers: direction in bits 30-31, size in 16-29, type in 8-15, number in 0-7.
func v4l2IOC(dir, nr, size uintptr) uintptr { return dir<<30 | size<<16 | 'V'<<8 | nr }

const (
	iocWrite     = 1
	iocRead      = 2
	iocReadWrite = 3
)

var (
	vidiocQueryCap       = v4l2IOC(iocRead, 0, unsafe.Sizeof(v4l2Capability{}))
	vidiocEnumFmt        = v4l2IOC(iocReadWrite, 2, unsafe.Sizeof(v4l2FmtDesc{}))
	vidiocSFmt           = v4l2IOC(iocReadWrite, 5, unsafe.Sizeof(v4l2Format{}))
	vidiocReqBufs        = v4l2IOC(iocReadWrite, 8, unsafe.Sizeof(v4l2RequestBuffers{}))
	vidiocQueryBuf       = v4l2IOC(iocReadWrite, 9, unsafe.Sizeof(v4l2Buffer{}))
	vidiocQBuf           = v4l2IOC(iocReadWrite, 15, unsafe.Sizeof(v4l2Buffer{}))
	vidiocDQBuf          = v4l2IOC(iocReadWrite, 17, unsafe.Sizeof(v4l2Buffer{}))
	vidiocStreamOn       = v4l2IOC(iocWrite, 18, 4)
	vidiocStreamOff      = v4l2IOC(iocWrite, 19, 4)
	vidiocSParm          = v4l2IOC(iocReadWrite, 22, unsafe.Sizeof(v4l2StreamParm{}))
	vidiocEnumFrameSizes = v4l2IOC(iocReadWrite, 74, unsafe.Sizeof(v4l2FrmSizeEnum{}))
	vidiocEnumFrameIvals = v4l2IOC(iocReadWrite, 75, unsafe.Sizeof(v4l2FrmIvalEnum{}))
)
