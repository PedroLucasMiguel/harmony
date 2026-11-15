package native

import (
	"bytes"
	"errors"
	"testing"
	"unsafe"
)

// The sizes and offsets are those of the C structs in libva's va.h and va_enc_h264.h, measured with a C compiler.
func TestVALayouts(t *testing.T) {
	size := func(name string, got uintptr, want int) {
		if int(got) != want {
			t.Errorf("sizeof %s = %d, want %d", name, got, want)
		}
	}
	size("VAConfigAttrib", unsafe.Sizeof(vaConfigAttrib{}), 8)
	size("VASurfaceAttrib", unsafe.Sizeof(vaSurfaceAttrib{}), 24)
	size("VAPictureH264", unsafe.Sizeof(vaPictureH264{}), 36)
	size("VAPictureParameterBufferH264", unsafe.Sizeof(vaPictureParameterBufferH264{}), 672)
	size("VAIQMatrixBufferH264", unsafe.Sizeof(vaIQMatrixBufferH264{}), 240)
	size("VASliceParameterBufferH264", unsafe.Sizeof(vaSliceParameterBufferH264{}), 3128)
	size("VAImageFormat", unsafe.Sizeof(vaImageFormat{}), 48)
	size("VAImage", unsafe.Sizeof(vaImage{}), 120)
	size("VACodedBufferSegment", unsafe.Sizeof(vaCodedBufferSegment{}), 48)
	size("VAEncPackedHeaderParameterBuffer", unsafe.Sizeof(vaEncPackedHeaderParameterBuffer{}), 28)
	size("VAEncMiscParameterRateControl", unsafe.Sizeof(vaEncMiscParameterRateControl{}), 60)
	size("VAEncMiscParameterFrameRate", unsafe.Sizeof(vaEncMiscParameterFrameRate{}), 24)
	size("VAEncMiscParameterHRD", unsafe.Sizeof(vaEncMiscParameterHRD{}), 24)
	size("VAEncSequenceParameterBufferH264", unsafe.Sizeof(vaEncSequenceParameterBufferH264{}), 1132)
	size("VAEncPictureParameterBufferH264", unsafe.Sizeof(vaEncPictureParameterBufferH264{}), 648)
	size("VAEncSliceParameterBufferH264", unsafe.Sizeof(vaEncSliceParameterBufferH264{}), 3140)

	var pp vaPictureParameterBufferH264
	size("pic.ReferenceFrames", unsafe.Offsetof(pp.ReferenceFrames), 36)
	size("pic.PictureWidthInMbsMinus1", unsafe.Offsetof(pp.PictureWidthInMbsMinus1), 612)
	size("pic.NumRefFrames", unsafe.Offsetof(pp.NumRefFrames), 618)
	size("pic.SeqFields", unsafe.Offsetof(pp.SeqFields), 620)
	size("pic.PicInitQpMinus26", unsafe.Offsetof(pp.PicInitQpMinus26), 628)
	size("pic.PicFields", unsafe.Offsetof(pp.PicFields), 632)
	size("pic.FrameNum", unsafe.Offsetof(pp.FrameNum), 636)

	var sp vaSliceParameterBufferH264
	size("slice.SliceDataBitOffset", unsafe.Offsetof(sp.SliceDataBitOffset), 12)
	size("slice.SliceType", unsafe.Offsetof(sp.SliceType), 16)
	size("slice.RefPicList0", unsafe.Offsetof(sp.RefPicList0), 28)
	size("slice.RefPicList1", unsafe.Offsetof(sp.RefPicList1), 1180)
	size("slice.LumaLog2WeightDenom", unsafe.Offsetof(sp.LumaLog2WeightDenom), 2332)
	size("slice.LumaWeightL0", unsafe.Offsetof(sp.LumaWeightL0), 2336)
	size("slice.ChromaWeightL0Flag", unsafe.Offsetof(sp.ChromaWeightL0Flag), 2464)
	size("slice.LumaWeightL1Flag", unsafe.Offsetof(sp.LumaWeightL1Flag), 2722)
	size("slice.ChromaOffsetL1", unsafe.Offsetof(sp.ChromaOffsetL1), 2982)

	var img vaImage
	size("image.Buf", unsafe.Offsetof(img.Buf), 52)
	size("image.NumPlanes", unsafe.Offsetof(img.NumPlanes), 64)
	size("image.Pitches", unsafe.Offsetof(img.Pitches), 68)
	size("image.Offsets", unsafe.Offsetof(img.Offsets), 80)

	var seq vaEncSequenceParameterBufferH264
	size("seq.PictureWidthInMbs", unsafe.Offsetof(seq.PictureWidthInMbs), 24)
	size("seq.SeqFields", unsafe.Offsetof(seq.SeqFields), 28)
	size("seq.OffsetForRefFrame", unsafe.Offsetof(seq.OffsetForRefFrame), 44)
	size("seq.FrameCroppingFlag", unsafe.Offsetof(seq.FrameCroppingFlag), 1068)
	size("seq.VuiFields", unsafe.Offsetof(seq.VuiFields), 1092)
	size("seq.TimeScale", unsafe.Offsetof(seq.TimeScale), 1112)

	var ep vaEncPictureParameterBufferH264
	size("encpic.CodedBuf", unsafe.Offsetof(ep.CodedBuf), 612)
	size("encpic.FrameNum", unsafe.Offsetof(ep.FrameNum), 620)
	size("encpic.PicFields", unsafe.Offsetof(ep.PicFields), 628)

	var es vaEncSliceParameterBufferH264
	size("encslice.SliceType", unsafe.Offsetof(es.SliceType), 12)
	size("encslice.DeltaPicOrderCnt", unsafe.Offsetof(es.DeltaPicOrderCnt), 24)
	size("encslice.RefPicList1", unsafe.Offsetof(es.RefPicList1), 1188)
	size("encslice.CabacInitIdc", unsafe.Offsetof(es.CabacInitIdc), 3118)
}

func TestExpGolombAndEscapes(t *testing.T) {
	r := &vdBits{b: []byte{0b1_010_011_0, 0b0100_0010, 0b1_0000000}}
	// ue: 1 -> 0, 010 -> 1, 011 -> 2, 00100 -> 3, 00101 -> 4 ; then se of 00100 is -1 ... read in order
	for i, want := range []int{0, 1, 2, 3} {
		if got := r.ue(); got != want {
			t.Fatalf("ue #%d = %d, want %d", i, got, want)
		}
	}
	se := &vdBits{b: []byte{0b010_011_00, 0b100_00101}}
	for i, want := range []int{1, -1, 2, -2} {
		if got := se.se(); got != want {
			t.Fatalf("se #%d = %d, want %d", i, got, want)
		}
	}
	if got := vdUnescape(nil, []byte{0, 0, 3, 1, 0, 0, 3, 0, 0, 3}); !bytes.Equal(got, []byte{0, 0, 1, 0, 0, 0, 0}) {
		t.Errorf("unescape = %x", got)
	}
	nals := vdSplit([]byte{0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 0}, nil)
	if len(nals) != 3 || !bytes.Equal(nals[0], []byte{0x67, 1, 2}) || !bytes.Equal(nals[1], []byte{0x68, 3}) || !bytes.Equal(nals[2], []byte{0x65, 4, 5}) {
		t.Errorf("split = %x", nals)
	}
	more := &vdBits{b: []byte{0b1010_0000, 0b1000_0000}}
	more.skip(4)
	if !more.moreData() {
		t.Error("moreData false with data before the stop bit")
	}
	more.skip(5)
	if more.moreData() {
		t.Error("moreData true at the stop bit")
	}
}

// The default scaling lists are sent in zigzag order; ffmpeg keeps them in raster order, which is what the hardware wants.
func TestDefaultScalingLists(t *testing.T) {
	raster4 := [2][16]uint8{
		{6, 13, 20, 28, 13, 20, 28, 32, 20, 28, 32, 37, 28, 32, 37, 42},
		{10, 14, 20, 24, 14, 20, 24, 27, 20, 24, 27, 30, 24, 27, 30, 34},
	}
	raster8 := [2][64]uint8{
		{6, 10, 13, 16, 18, 23, 25, 27, 10, 11, 16, 18, 23, 25, 27, 29, 13, 16, 18, 23, 25, 27, 29, 31, 16, 18, 23, 25, 27, 29, 31, 33,
			18, 23, 25, 27, 29, 31, 33, 36, 23, 25, 27, 29, 31, 33, 36, 38, 25, 27, 29, 31, 33, 36, 38, 40, 27, 29, 31, 33, 36, 38, 40, 42},
		{9, 13, 15, 17, 19, 21, 22, 24, 13, 13, 17, 19, 21, 22, 24, 25, 15, 17, 19, 21, 22, 24, 25, 27, 17, 19, 21, 22, 24, 25, 27, 28,
			19, 21, 22, 24, 25, 27, 28, 30, 21, 22, 24, 25, 27, 28, 30, 32, 22, 24, 25, 27, 28, 30, 32, 33, 24, 25, 27, 28, 30, 32, 33, 35},
	}
	for i, zz := range [][16]uint8{vdDefault4Intra, vdDefault4Inter} {
		var got [16]uint8
		for k, v := range zz {
			got[vdZigzag4[k]] = v
		}
		if got != raster4[i] {
			t.Errorf("4x4 list %d raster = %v", i, got)
		}
	}
	for i, zz := range [][64]uint8{vdDefault8Intra, vdDefault8Inter} {
		var got [64]uint8
		for k, v := range zz {
			got[vdZigzag8[k]] = v
		}
		if got != raster8[i] {
			t.Errorf("8x8 list %d raster = %v", i, got)
		}
	}
}

func tinyAccessUnits() [][]byte {
	var aus [][]byte
	var cur []byte
	for _, nal := range vdSplit(tinyStream, nil) {
		cur = append(cur, 0, 0, 0, 1)
		cur = append(cur, nal...)
		if typ := nal[0] & 31; typ == 1 || typ == 5 {
			aus = append(aus, cur)
			cur = nil
		}
	}
	return aus
}

// recordSink stands in for the hardware: it remembers what was decoded and in which order pictures were shown.
type recordSink struct {
	t        *testing.T
	pocs     map[vaSurfaceID]int32
	decoded  int
	shown    []int32
	opened   int
	failNext bool
}

func (s *recordSink) open(sps *vdSPS, n int) ([]vaSurfaceID, error) {
	s.opened++
	s.pocs = map[vaSurfaceID]int32{}
	ids := make([]vaSurfaceID, n)
	for i := range ids {
		ids[i] = vaSurfaceID(100 + i)
	}
	return ids, nil
}

func (s *recordSink) decode(target vaSurfaceID, pic *vaPictureParameterBufferH264, iq *vaIQMatrixBufferH264, sl *vdSlices) error {
	if s.failNext {
		s.failNext = false
		return errors.New("decode failed")
	}
	s.decoded++
	s.pocs[target] = min(pic.CurrPic.TopFieldOrderCnt, pic.CurrPic.BottomFieldOrderCnt)
	refs := map[vaSurfaceID]bool{}
	for _, r := range pic.ReferenceFrames {
		if r.Flags&vaPictureH264Invalid == 0 {
			refs[r.PictureID] = true
		}
	}
	for i := range sl.params {
		p := &sl.params[i]
		lists := [][32]vaPictureH264{p.RefPicList0, p.RefPicList1}
		counts := []int{int(p.NumRefIdxL0ActiveMinus1) + 1, int(p.NumRefIdxL1ActiveMinus1) + 1}
		if p.SliceType == vdSliceI {
			continue
		}
		for l := 0; l < 1+b2i(p.SliceType == vdSliceB); l++ {
			for k := 0; k < counts[l]; k++ {
				if e := lists[l][k]; e.Flags&vaPictureH264Invalid != 0 || !refs[e.PictureID] {
					s.t.Errorf("picture %d slice %d list %d entry %d is not a reference of the picture", s.decoded, i, l, k)
				}
			}
		}
	}
	return nil
}

func (s *recordSink) show(_ *vdSPS, surface vaSurfaceID) error {
	s.shown = append(s.shown, s.pocs[surface])
	return nil
}

func (s *recordSink) behind() bool { return false }

func newTestAssembler(t *testing.T) (*vdAssembler, *recordSink) {
	s := &recordSink{t: t}
	return newVDAssembler(s, func(msg string) { t.Log(msg) }), s
}

func TestAssemblerOrdersBFrames(t *testing.T) {
	a, s := newTestAssembler(t)
	aus := tinyAccessUnits()
	if len(aus) != 14 {
		t.Fatalf("%d access units", len(aus))
	}
	if !a.needKey.Load() {
		t.Error("a new decoder does not ask for a key frame")
	}
	for _, au := range aus {
		a.write(au)
	}
	a.flushOutput()
	if a.needKey.Load() {
		t.Error("still asks for a key frame after decoding the stream")
	}
	if s.decoded != 14 || len(s.shown) != 14 || s.opened != 1 {
		t.Fatalf("decoded %d, shown %d, opened %d", s.decoded, len(s.shown), s.opened)
	}
	for i := 1; i < len(s.shown); i++ {
		if s.shown[i] <= s.shown[i-1] && s.shown[i] != 0 {
			t.Errorf("picture %d has order count %d after %d: %v", i, s.shown[i], s.shown[i-1], s.shown)
		}
	}
}

func TestAssemblerWaitsForKeyFrame(t *testing.T) {
	a, s := newTestAssembler(t)
	aus := tinyAccessUnits()
	for _, au := range aus[1:8] {
		a.write(au)
	}
	if s.decoded != 0 || !a.needKey.Load() {
		t.Fatalf("decoded %d pictures before a key frame, needKey %v", s.decoded, a.needKey.Load())
	}
	for _, au := range aus[8:] {
		a.write(au)
	}
	a.flushOutput()
	if s.decoded != 6 || a.needKey.Load() {
		t.Errorf("decoded %d pictures after the key frame, needKey %v", s.decoded, a.needKey.Load())
	}
}

func TestAssemblerSurvivesLossAndGarbage(t *testing.T) {
	a, s := newTestAssembler(t)
	aus := tinyAccessUnits()
	for _, au := range aus[:3] {
		a.write(au)
	}
	// a lost picture is a gap in frame_num
	a.write(aus[5])
	if !a.needKey.Load() {
		t.Error("a lost picture does not ask for a key frame")
	}
	a.write([]byte{0, 0, 0, 1, 0x41, 0xff, 0xff})
	a.write([]byte{1, 2, 3, 0, 0, 1, 0x65})
	a.write(nil)
	for _, au := range aus[8:] {
		a.write(au)
	}
	if s.opened != 1 || a.needKey.Load() {
		t.Errorf("opened %d, needKey %v after recovering", s.opened, a.needKey.Load())
	}
	s.failNext = true
	a.write(aus[8])
	if !a.needKey.Load() {
		t.Error("a failed decode does not ask for a key frame")
	}
}

func TestSequenceParameterSet(t *testing.T) {
	var sets vdSets
	for _, nal := range vdSplit(tinyStream, nil) {
		switch nal[0] & 31 {
		case 7:
			if err := sets.addSPS(nal); err != nil {
				t.Fatal(err)
			}
		case 8:
			sets.addPPS(nal)
		}
	}
	pps, sps := sets.find(0)
	if pps == nil || sps.width() != 48 || sps.height() != 32 || sps.profile != 100 || sps.numRefFrames != 4 || !pps.cabac {
		t.Fatalf("sps %+v pps %+v", sps, pps)
	}
	if sps.outWidth() != 48 || sps.outHeight() != 32 || pps.lists.l4[0] != vdDefault4Intra || pps.lists.l4[3] != vdDefault4Inter ||
		pps.lists.l8[0] != vdDefault8Intra || pps.lists.l8[1] != vdDefault8Inter {
		t.Errorf("crop %dx%d or the default scaling matrices of the picture parameter set: %v", sps.outWidth(), sps.outHeight(), pps.lists)
	}
}

func TestVDFit(t *testing.T) {
	for _, c := range []struct{ w, h, bw, bh, ow, oh int }{
		{1920, 1080, 640, 360, 640, 360},
		{1920, 1080, 640, 640, 640, 360},
		{1280, 720, 1920, 1080, 1280, 720},
		{640, 480, 0, 0, 640, 480},
		{1080, 1920, 640, 360, 202, 360},
	} {
		if w, h := vdFit(c.w, c.h, c.bw, c.bh); w != c.ow || h != c.oh {
			t.Errorf("fit %dx%d in %dx%d = %dx%d, want %dx%d", c.w, c.h, c.bw, c.bh, w, h, c.ow, c.oh)
		}
	}
}

// A flat grey picture is the same grey at any size, and a picture that is shrunk keeps the average of what it covered.
func TestScalerKeepsColour(t *testing.T) {
	const w, h = 64, 48
	y := make([]byte, w*h)
	uv := make([]byte, w*h/2)
	for i := range y {
		y[i] = 126
	}
	for i := range uv {
		uv[i] = 128
	}
	var s vdScaler
	full := make([]byte, w*h*4)
	small := make([]byte, 32*24*4)
	s.convert(full, y, w, uv, w, 0, 0, w, h, w, h, BT709, false)
	s.convert(small, y, w, uv, w, 0, 0, w, h, 32, 24, BT709, false)
	for _, px := range [][]byte{full[:4], full[len(full)-4:], small[:4], small[len(small)-4:]} {
		if px[0] != full[0] || px[1] != full[1] || px[2] != full[2] || px[3] != 255 {
			t.Fatalf("pixel %v differs from %v", px, full[:4])
		}
	}
	for x := 0; x < w; x++ {
		for r := 0; r < h; r++ {
			y[r*w+x] = byte(100 + 100*(x&1))
		}
	}
	s.convert(small, y, w, uv, w, 0, 0, w, h, 32, 24, BT709, true)
	if small[0] != 150 {
		t.Errorf("average of 100 and 200 = %d", small[0])
	}
}
