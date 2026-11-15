package native

import (
	"testing"
	"unsafe"
)

// Sizes and ioctl numbers as the C compiler gives them for linux/videodev2.h on 64-bit Linux.
func TestV4L2Layout(t *testing.T) {
	for _, c := range []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{"v4l2_capability", unsafe.Sizeof(v4l2Capability{}), 104},
		{"v4l2_format", unsafe.Sizeof(v4l2Format{}), 208},
		{"v4l2_fmtdesc", unsafe.Sizeof(v4l2FmtDesc{}), 64},
		{"v4l2_requestbuffers", unsafe.Sizeof(v4l2RequestBuffers{}), 20},
		{"v4l2_buffer", unsafe.Sizeof(v4l2Buffer{}), 88},
		{"v4l2_streamparm", unsafe.Sizeof(v4l2StreamParm{}), 204},
		{"v4l2_frmsizeenum", unsafe.Sizeof(v4l2FrmSizeEnum{}), 44},
		{"v4l2_frmivalenum", unsafe.Sizeof(v4l2FrmIvalEnum{}), 52},
		{"buffer.offset", unsafe.Offsetof(v4l2Buffer{}.Offset), 64},
		{"buffer.length", unsafe.Offsetof(v4l2Buffer{}.Length), 72},
		{"buffer.sequence", unsafe.Offsetof(v4l2Buffer{}.Sequence), 56},
		{"format.pix", unsafe.Offsetof(v4l2Format{}.Pix), 8},
		{"VIDIOC_QUERYCAP", vidiocQueryCap, 0x80685600},
		{"VIDIOC_S_FMT", vidiocSFmt, 0xc0d05605},
		{"VIDIOC_REQBUFS", vidiocReqBufs, 0xc0145608},
		{"VIDIOC_QBUF", vidiocQBuf, 0xc058560f},
		{"VIDIOC_DQBUF", vidiocDQBuf, 0xc0585611},
		{"VIDIOC_STREAMON", vidiocStreamOn, 0x40045612},
		{"VIDIOC_ENUM_FRAMESIZES", vidiocEnumFrameSizes, 0xc02c564a},
		{"VIDIOC_ENUM_FRAMEINTERVALS", vidiocEnumFrameIvals, 0xc034564b},
	} {
		if c.got != c.want {
			t.Errorf("%s: %#x, want %#x", c.name, c.got, c.want)
		}
	}
}
