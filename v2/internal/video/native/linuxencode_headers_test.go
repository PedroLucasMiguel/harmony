package native

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// Reference streams made by ffmpeg with libx264 (-bf 0 -g 60, VUI colour tags, bt709 or smpte170m, no weighted
// prediction); the headers here are the NAL units it wrote.
var h264References = []struct {
	name     string
	cfg      h264Config
	sps, pps string
}{
	{"720p baseline", h264Config{W: 1280, H: 720, FPS: 30, Matrix: BT709, Profile: 66, Level: 31, InitQP: 26, Log2MaxFrameNum: 4, POCType: 2, Log2MaxMV: 11, MaxDecBuffered: 1},
		"6742c01fda014016ec05a808080a000003000200000300781e306540", "68ce3c80"},
	{"720p main", h264Config{W: 1280, H: 720, FPS: 30, Matrix: BT709, Profile: 77, Level: 31, CABAC: true, InitQP: 26, Log2MaxFrameNum: 4, POCType: 2, Log2MaxMV: 11, MaxDecBuffered: 1},
		"674d401fda014016ec05a808080a000003000200000300781e306540", "68ee3c80"},
	{"360p baseline bt601 cropped", h264Config{W: 640, H: 360, FPS: 24, Matrix: BT601, Profile: 66, Level: 30, InitQP: 26, Log2MaxFrameNum: 4, POCType: 2, Log2MaxMV: 10, MaxDecBuffered: 1},
		"6742c01eda0280bfe5c05a80808320000003002000000601e2c5d4", "68ce3c80"},
	{"1080p main cropped", h264Config{W: 1920, H: 1080, FPS: 30, Matrix: BT709, Profile: 77, Level: 40, CABAC: true, InitQP: 26, Log2MaxFrameNum: 4, POCType: 2, Log2MaxMV: 11, MaxDecBuffered: 1},
		"674d4028da01e0089f97016a02020280000003008000001e078c1950", "68ee3c80"},
	{"720p high", h264Config{W: 1280, H: 720, FPS: 30, Matrix: BT709, Profile: 100, Level: 31, CABAC: true, InitQP: 26, Log2MaxFrameNum: 4, POCType: 2, Log2MaxMV: 11, MaxDecBuffered: 1},
		"6764001facb402802dd80b50101014000003000400000300f03c60ca80", "68ee3cb0"},
	{"1080p high cropped", h264Config{W: 1920, H: 1080, FPS: 30, Matrix: BT709, Profile: 100, Level: 40, CABAC: true, InitQP: 26, Log2MaxFrameNum: 4, POCType: 2, Log2MaxMV: 11, MaxDecBuffered: 1},
		"67640028acb403c0113f2e02d40404050000030001000003003c0f1832a0", "68ee3cb0"},
}

func mustHex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParameterSetsMatchX264(t *testing.T) {
	startCode := []byte{0, 0, 0, 1}
	for _, r := range h264References {
		if got, want := r.cfg.appendSPS(nil), append(startCode, mustHex(t, r.sps)...); !bytes.Equal(got, want) {
			t.Errorf("%s SPS\n got %x\nwant %x", r.name, got, want)
		}
		if got, want := r.cfg.appendPPS(nil), append(startCode, mustHex(t, r.pps)...); !bytes.Equal(got, want) {
			t.Errorf("%s PPS\n got %x\nwant %x", r.name, got, want)
		}
	}
}

func TestBitWriterExpGolombAndEmulationPrevention(t *testing.T) {
	var w vaBitWriter
	w.reset(nil)
	for _, v := range []uint32{0, 1, 2, 3, 4, 7, 8} {
		w.ue(v)
	}
	w.se(-1)
	w.se(1)
	w.se(0)
	// 1 010 011 00100 00101 0001000 0001001 011 010 1 and zero padding
	if got, want := w.finish(), []byte{0xa6, 0x42, 0x88, 0x12, 0xd4}; !bytes.Equal(got, want) {
		t.Errorf("exp-Golomb: got %x want %x", got, want)
	}
	w.reset(nil)
	w.epb = true
	w.bits(0, 24)
	w.bits(1, 8)
	if got, want := w.finish(), []byte{0, 0, 3, 0, 1}; !bytes.Equal(got, want) {
		t.Errorf("emulation prevention: got %x want %x", got, want)
	}
}

func TestH264Level(t *testing.T) {
	for _, c := range []struct {
		w, h, fps, kbps int
		want            byte
	}{{1280, 720, 30, 2000, 31}, {1920, 1080, 30, 6000, 40}, {1920, 1080, 60, 8000, 42}, {640, 360, 24, 800, 30}, {2560, 1440, 30, 12000, 50}} {
		if got := h264Level(c.w, c.h, c.fps, c.kbps); got != c.want {
			t.Errorf("%dx%d@%d %dk: level %d, want %d", c.w, c.h, c.fps, c.kbps, got, c.want)
		}
	}
}

func TestAppendVideoNALs(t *testing.T) {
	in := []byte{0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3, 0, 0, 1, 0x06, 9, 0, 0, 1, 0x65, 0xaa, 0, 0xbb, 0, 0, 0, 1, 0x41, 0xcc, 0}
	want := []byte{0, 0, 0, 1, 0x65, 0xaa, 0, 0xbb, 0, 0, 0, 1, 0x41, 0xcc}
	if got := appendVideoNALs(nil, in); !bytes.Equal(got, want) {
		t.Errorf("got %x want %x", got, want)
	}
}

func TestCopyNV12Padded(t *testing.T) {
	nv12 := []byte{1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 22, 23} // 4x2: two rows of Y, one of UV
	dst := make([]byte, 6*4+6*2)
	if !copyNV12Padded(dst, 0, 6, 24, 6, nv12, 4, 2, 6, 4) {
		t.Fatal("rejected")
	}
	want := []byte{1, 2, 3, 4, 4, 4, 5, 6, 7, 8, 8, 8, 5, 6, 7, 8, 8, 8, 5, 6, 7, 8, 8, 8,
		20, 21, 22, 23, 22, 23, 20, 21, 22, 23, 22, 23}
	if !bytes.Equal(dst, want) {
		t.Errorf("got %v\nwant %v", dst, want)
	}
}

func TestPCIIDsName(t *testing.T) {
	db := "# comment\n8086  Intel Corporation\n\t56a5  DG2 [Arc A380]\n\t9a49  TigerLake-LP GT2 [Iris Xe Graphics]\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t73ff  Navi 23 [Radeon RX 6600/6600 XT/6600M]\n"
	for _, c := range []struct {
		vendor, device uint32
		want           string
	}{{0x8086, 0x56a5, "Intel Arc A380"}, {0x8086, 0x9a49, "Intel Iris Xe Graphics"}, {0x1002, 0x73ff, "AMD Radeon RX 6600/6600 XT/6600M"}, {0x1002, 0x1, ""}} {
		if got := pciIDsName(db, c.vendor, c.device); got != c.want {
			t.Errorf("%04x:%04x: %q, want %q", c.vendor, c.device, got, c.want)
		}
	}
}
