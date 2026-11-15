package native

// H.264 sequence and picture parameter sets for the VA-API decoder: what the hardware needs in its parameter buffers,
// with the scaling lists resolved through the fall-back rules and the colour description of the VUI.

import (
	"bytes"
	"errors"
)

var (
	vdDefault4Intra = [16]uint8{6, 13, 13, 20, 20, 20, 28, 28, 28, 28, 32, 32, 32, 37, 37, 42}
	vdDefault4Inter = [16]uint8{10, 14, 14, 20, 20, 20, 24, 24, 24, 24, 27, 27, 27, 30, 30, 34}
	vdDefault8Intra = [64]uint8{6, 10, 10, 13, 11, 13, 16, 16, 16, 16, 18, 18, 18, 18, 18, 23, 23, 23, 23, 23, 23, 25, 25, 25, 25, 25, 25, 25, 27, 27, 27, 27,
		27, 27, 27, 27, 29, 29, 29, 29, 29, 29, 29, 31, 31, 31, 31, 31, 31, 33, 33, 33, 33, 33, 36, 36, 36, 36, 38, 38, 38, 40, 40, 42}
	vdDefault8Inter = [64]uint8{9, 13, 13, 15, 13, 15, 17, 17, 17, 17, 19, 19, 19, 19, 19, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 22, 24, 24, 24, 24,
		24, 24, 24, 24, 25, 25, 25, 25, 25, 25, 25, 27, 27, 27, 27, 27, 27, 28, 28, 28, 28, 28, 30, 30, 30, 30, 32, 32, 32, 33, 33, 35}

	// vdZigzag4 and vdZigzag8 give the raster position of each coefficient of a scaling list, which is sent in zigzag order.
	vdZigzag4 = [16]uint8{0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15}
	vdZigzag8 = [64]uint8{0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
		35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63}
)

var errVDUnsupported = errors.New("unsupported H.264 stream")

// vdLists are the 4x4 and 8x8 scaling lists in the order the stream sends them (zigzag).
type vdLists struct {
	l4 [6][16]uint8
	l8 [6][64]uint8
}

func (l *vdLists) flat() {
	for i := range l.l4 {
		for j := range l.l4[i] {
			l.l4[i][j] = 16
		}
	}
	for i := range l.l8 {
		for j := range l.l8[i] {
			l.l8[i][j] = 16
		}
	}
}

// vdSPS is a sequence parameter set.
type vdSPS struct {
	raw                []byte
	profile            int
	constraints        int
	level              int
	id                 int
	chroma             int
	separateColour     bool
	hasMatrix          bool
	lists              vdLists
	log2MaxFrameNum    int
	pocType            int
	log2MaxPocLsb      int
	deltaPocAlwaysZero bool
	offsetNonRef       int
	offsetTopBottom    int
	offsetRef          []int
	numRefFrames       int
	gaps               bool
	mbsW, mbsH         int
	frameMbsOnly       bool
	mbaff              bool
	direct8x8          bool
	cropL, cropR       int
	cropT, cropB       int

	signalType bool
	fullRange  bool
	matrix     int
	numReorder int
	hasReorder bool
}

func (s *vdSPS) width() int  { return s.mbsW * 16 }
func (s *vdSPS) height() int { return s.mbsH * 16 }

func (s *vdSPS) outWidth() int  { return s.width() - s.cropL - s.cropR }
func (s *vdSPS) outHeight() int { return s.height() - s.cropT - s.cropB }

func (s *vdSPS) maxFrameNum() int { return 1 << s.log2MaxFrameNum }

func vdHighProfile(p int) bool {
	switch p {
	case 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135:
		return true
	}
	return false
}

// parseScalingList reads one list; useDefault is true when the stream asks for the default list.
func (r *vdBits) scalingList(out []uint8) (useDefault bool) {
	last, next := 8, 8
	for j := range out {
		if next != 0 {
			next = (last + r.se() + 256) % 256
			useDefault = j == 0 && next == 0
		}
		if next != 0 {
			last = next
		}
		out[j] = uint8(last)
	}
	return useDefault
}

// readLists reads count lists of a scaling matrix. The lists that are absent take their fall-back: the defaults at
// positions 0, 3, 6 and 7 for rule A (base == nil) or the matching list of base for rule B, and the list before it (two
// before it for the 8x8 chroma lists) elsewhere.
func (r *vdBits) readLists(l *vdLists, count int, base *vdLists) {
	for i := 0; i < count; i++ {
		present := r.flag()
		var dst []uint8
		var def []uint8
		switch {
		case i < 6:
			dst = l.l4[i][:]
			def = vdDefault4Intra[:]
			if i >= 3 {
				def = vdDefault4Inter[:]
			}
		default:
			dst = l.l8[i-6][:]
			def = vdDefault8Intra[:]
			if i%2 == 1 {
				def = vdDefault8Inter[:]
			}
		}
		if present {
			if r.scalingList(dst) {
				copy(dst, def)
			}
			continue
		}
		switch {
		case i == 0 || i == 3:
			if base != nil {
				copy(dst, base.l4[i][:])
			} else {
				copy(dst, def)
			}
		case i == 6 || i == 7:
			if base != nil {
				copy(dst, base.l8[i-6][:])
			} else {
				copy(dst, def)
			}
		case i < 6:
			copy(dst, l.l4[i-1][:])
		default:
			copy(dst, l.l8[i-8][:])
		}
	}
}

// parseSPS reads a sequence parameter set NAL unit (with its header byte).
func parseSPS(nal []byte) (*vdSPS, error) {
	r := &vdBits{b: vdUnescape(nil, nal[1:])}
	s := &vdSPS{raw: bytes.Clone(nal), chroma: 1, numReorder: -1}
	s.profile = r.bits(8)
	s.constraints = r.bits(8)
	s.level = r.bits(8)
	s.id = r.ue()
	s.lists.flat()
	if vdHighProfile(s.profile) {
		if s.chroma = r.ue(); s.chroma == 3 {
			s.separateColour = r.flag()
		}
		lumaDepth, chromaDepth := r.ue(), r.ue()
		r.bit()
		if lumaDepth != 0 || chromaDepth != 0 || s.chroma != 1 {
			return nil, errVDUnsupported
		}
		if s.hasMatrix = r.flag(); s.hasMatrix {
			r.readLists(&s.lists, 8, nil)
		}
	}
	s.log2MaxFrameNum = r.ue() + 4
	s.pocType = r.ue()
	switch s.pocType {
	case 0:
		s.log2MaxPocLsb = r.ue() + 4
	case 1:
		s.deltaPocAlwaysZero = r.flag()
		s.offsetNonRef = r.se()
		s.offsetTopBottom = r.se()
		n := r.ue()
		if n > 255 {
			return nil, errVDUnsupported
		}
		s.offsetRef = make([]int, n)
		for i := range s.offsetRef {
			s.offsetRef[i] = r.se()
		}
	case 2:
	default:
		return nil, errVDUnsupported
	}
	s.numRefFrames = r.ue()
	s.gaps = r.flag()
	s.mbsW = r.ue() + 1
	mapH := r.ue() + 1
	s.frameMbsOnly = r.flag()
	s.mbsH = mapH
	if !s.frameMbsOnly {
		s.mbsH = mapH * 2
		s.mbaff = r.flag()
	}
	s.direct8x8 = r.flag()
	if r.flag() {
		unitX, unitY := 2, 2*(2-b2i(s.frameMbsOnly))
		s.cropL, s.cropR = r.ue()*unitX, r.ue()*unitX
		s.cropT, s.cropB = r.ue()*unitY, r.ue()*unitY
	}
	if r.over || s.numRefFrames > 16 || s.mbsW > 1024 || s.mbsH > 1024 || s.log2MaxFrameNum > 16 ||
		s.outWidth() < 16 || s.outHeight() < 16 {
		return nil, errVDUnsupported
	}
	if r.flag() {
		s.readVUI(r)
	}
	return s, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *vdSPS) readVUI(r *vdBits) {
	if r.flag() && r.bits(8) == 255 {
		r.skip(32)
	}
	if r.flag() {
		r.bit()
	}
	if r.flag() {
		r.skip(3)
		s.signalType = true
		s.fullRange = r.flag()
		s.matrix = 2
		if r.flag() {
			r.skip(16)
			s.matrix = r.bits(8)
		}
	}
	if r.flag() {
		r.ue()
		r.ue()
	}
	if r.flag() {
		r.skip(64)
		r.bit()
	}
	nal, vcl := r.flag(), false
	if nal {
		r.hrd()
	}
	if vcl = r.flag(); vcl {
		r.hrd()
	}
	if nal || vcl {
		r.bit()
	}
	r.bit()
	if r.flag() {
		r.bit()
		r.ue()
		r.ue()
		r.ue()
		r.ue()
		s.numReorder = r.ue()
		s.hasReorder = true
		r.ue()
	}
	if r.over {
		s.hasReorder = false
		s.numReorder = -1
	}
}

func (r *vdBits) hrd() {
	n := r.ue() + 1
	r.skip(8)
	for i := 0; i < n && i < 32 && !r.over; i++ {
		r.ue()
		r.ue()
		r.bit()
	}
	r.skip(20)
}

// vdPPS is a picture parameter set with the scaling lists in force for it.
type vdPPS struct {
	raw               []byte
	id, spsID         int
	sps               *vdSPS
	cabac             bool
	bottomPocPresent  bool
	numRefDefault     [2]int
	weightedPred      bool
	weightedBipredIdc int
	initQp            int
	initQs            int
	chromaQpOffset    int
	chromaQpOffset2   int
	deblockingControl bool
	constrainedIntra  bool
	redundantPicCnt   bool
	transform8x8      bool
	lists             vdLists
}

// vdPPSIDs reads the numbers of a picture parameter set and of the sequence parameter set it names.
func vdPPSIDs(nal []byte) (id, spsID int) {
	r := &vdBits{b: vdUnescape(nil, nal[1:])}
	return r.ue(), r.ue()
}

func parsePPS(nal []byte, sps *vdSPS) (*vdPPS, error) {
	r := &vdBits{b: vdUnescape(nil, nal[1:])}
	p := &vdPPS{raw: bytes.Clone(nal), sps: sps}
	p.id, p.spsID = r.ue(), r.ue()
	p.cabac = r.flag()
	p.bottomPocPresent = r.flag()
	if r.ue() != 0 {
		return nil, errVDUnsupported
	}
	p.numRefDefault = [2]int{r.ue() + 1, r.ue() + 1}
	p.weightedPred = r.flag()
	p.weightedBipredIdc = r.bits(2)
	p.initQp = 26 + r.se()
	p.initQs = 26 + r.se()
	p.chromaQpOffset = r.se()
	p.deblockingControl = r.flag()
	p.constrainedIntra = r.flag()
	p.redundantPicCnt = r.flag()
	p.chromaQpOffset2 = p.chromaQpOffset
	p.lists = sps.lists
	if r.moreData() {
		p.transform8x8 = r.flag()
		if r.flag() {
			count := 6 + 2*b2i(p.transform8x8)
			if sps.hasMatrix {
				r.readLists(&p.lists, count, &sps.lists)
			} else {
				r.readLists(&p.lists, count, nil)
			}
		}
		p.chromaQpOffset2 = r.se()
	}
	if r.over || p.numRefDefault[0] > 32 || p.numRefDefault[1] > 32 || p.id > 255 || p.spsID > 31 {
		return nil, errVDUnsupported
	}
	return p, nil
}

// vdSets keeps the parameter sets the stream has sent.
type vdSets struct {
	sps    [32]*vdSPS
	ppsRaw [256][]byte
	pps    [256]*vdPPS
}

func (s *vdSets) addSPS(nal []byte) error {
	sps, err := parseSPS(nal)
	if err != nil {
		return err
	}
	if old := s.sps[sps.id&31]; old != nil && bytes.Equal(old.raw, nal) {
		return nil
	}
	s.sps[sps.id&31] = sps
	return nil
}

func (s *vdSets) addPPS(nal []byte) {
	r := &vdBits{b: vdUnescape(nil, nal[1:])}
	id := r.ue()
	if r.over || id > 255 {
		return
	}
	if !bytes.Equal(s.ppsRaw[id], nal) {
		s.ppsRaw[id] = bytes.Clone(nal)
		s.pps[id] = nil
	}
}

// find returns the picture parameter set and the sequence parameter set it belongs to.
func (s *vdSets) find(ppsID int) (*vdPPS, *vdSPS) {
	if ppsID < 0 || ppsID > 255 || s.ppsRaw[ppsID] == nil {
		return nil, nil
	}
	if p := s.pps[ppsID]; p != nil && p.sps == s.sps[p.spsID] {
		return p, p.sps
	}
	_, spsID := vdPPSIDs(s.ppsRaw[ppsID])
	sps := s.sps[spsID&31]
	if sps == nil {
		return nil, nil
	}
	p, err := parsePPS(s.ppsRaw[ppsID], sps)
	if err != nil {
		return nil, nil
	}
	s.pps[ppsID] = p
	return p, sps
}
