package native

// The H.264 slice header for the VA-API decoder: everything the hardware's slice parameters, the reference picture lists
// and the decoded picture buffer need, and the bit offset where the slice data starts.

const (
	vdSliceP  = 0
	vdSliceB  = 1
	vdSliceI  = 2
	vdSliceSP = 3
	vdSliceSI = 4
)

type vdRefMod struct{ idc, val int }

// vdMMCO is one memory management control operation: a is the first and b the second argument.
type vdMMCO struct{ op, a, b int }

// vdWeights are the explicit weighted prediction tables of both lists; an entry the stream does not give has the default.
type vdWeights struct {
	lumaDenom, chromaDenom int
	luma                   [2]bool
	chroma                 [2]bool
	lw, lo                 [2][32]int16
	cw, co                 [2][32][2]int16
}

type vdSlice struct {
	nalRefIdc      int
	idr            bool
	firstMb        int
	sliceType      int
	ppsID          int
	frameNum       int
	field          bool
	idrPicID       int
	pocLsb         int
	deltaPocBottom int
	deltaPoc       [2]int
	redundant      int
	directSpatial  bool
	numRef         [2]int
	mods           [2][34]vdRefMod
	numMods        [2]int
	weights        vdWeights
	noOutputPrior  bool
	longTermRef    bool
	adaptive       bool
	mmco           [34]vdMMCO
	numMMCO        int
	cabacInitIdc   int
	qpDelta        int
	disableDeblock int
	alpha, beta    int
	// dataBitOffset is where slice_data() starts counted in the unescaped bits from the NAL unit's header byte.
	dataBitOffset int
}

func (s *vdSlice) isB() bool { return s.sliceType == vdSliceB }
func (s *vdSlice) isIntra() bool {
	return s.sliceType == vdSliceI || s.sliceType == vdSliceSI
}

func (s *vdSlice) hasMMCO5() bool {
	for _, m := range s.mmco[:s.numMMCO] {
		if m.op == 5 {
			return true
		}
	}
	return false
}

// vdNewPicture reports whether the slice h starts a picture other than the one first belongs to (7.4.1.2.4).
func vdNewPicture(first, h *vdSlice) bool {
	return first.frameNum != h.frameNum || first.ppsID != h.ppsID || first.idr != h.idr ||
		(first.nalRefIdc == 0) != (h.nalRefIdc == 0) || first.idr && first.idrPicID != h.idrPicID ||
		first.pocLsb != h.pocLsb || first.deltaPocBottom != h.deltaPocBottom || first.deltaPoc != h.deltaPoc
}

// vdSliceIDs reads the parameter set a slice uses from the start of its header.
func vdSliceIDs(rbsp []byte) (ppsID int) {
	r := &vdBits{b: rbsp}
	r.ue()
	r.ue()
	return r.ue()
}

// parseSlice reads the header of a slice NAL unit; rbsp is its payload after the header byte, unescaped. It reports false
// for slices this decoder does not take (fields, other slice groups, damaged headers).
func parseSlice(s *vdSlice, rbsp []byte, nalType, nalRefIdc int, pps *vdPPS, sps *vdSPS) bool {
	*s = vdSlice{nalRefIdc: nalRefIdc, idr: nalType == 5}
	r := &vdBits{b: rbsp}
	s.firstMb = r.ue()
	s.sliceType = r.ue() % 5
	s.ppsID = r.ue()
	if sps.separateColour {
		r.skip(2)
	}
	s.frameNum = r.bits(sps.log2MaxFrameNum)
	if !sps.frameMbsOnly {
		if s.field = r.flag(); s.field {
			return false
		}
	}
	if s.idr {
		s.idrPicID = r.ue()
	}
	switch sps.pocType {
	case 0:
		s.pocLsb = r.bits(sps.log2MaxPocLsb)
		if pps.bottomPocPresent {
			s.deltaPocBottom = r.se()
		}
	case 1:
		if !sps.deltaPocAlwaysZero {
			s.deltaPoc[0] = r.se()
			if pps.bottomPocPresent {
				s.deltaPoc[1] = r.se()
			}
		}
	}
	if pps.redundantPicCnt {
		s.redundant = r.ue()
	}
	if s.isB() {
		s.directSpatial = r.flag()
	}
	if !s.isIntra() {
		s.numRef = [2]int{pps.numRefDefault[0], 0}
		if s.isB() {
			s.numRef[1] = pps.numRefDefault[1]
		}
		if r.flag() {
			s.numRef[0] = r.ue() + 1
			if s.isB() {
				s.numRef[1] = r.ue() + 1
			}
		}
		if s.numRef[0] > 32 || s.numRef[1] > 32 {
			return false
		}
		for list := 0; list < 1+b2i(s.isB()); list++ {
			if !r.flag() {
				continue
			}
			for {
				idc := r.ue()
				if idc == 3 || r.over {
					break
				}
				if idc > 5 || s.numMods[list] >= len(s.mods[list]) {
					return false
				}
				s.mods[list][s.numMods[list]] = vdRefMod{idc, r.ue()}
				s.numMods[list]++
			}
		}
	}
	if pps.weightedPred && (s.sliceType == vdSliceP || s.sliceType == vdSliceSP) || pps.weightedBipredIdc == 1 && s.isB() {
		s.readWeights(r)
	}
	if nalRefIdc != 0 {
		if s.idr {
			s.noOutputPrior = r.flag()
			s.longTermRef = r.flag()
		} else if s.adaptive = r.flag(); s.adaptive {
			for {
				op := r.ue()
				if op == 0 || r.over {
					break
				}
				if op > 6 || s.numMMCO >= len(s.mmco) {
					return false
				}
				m := vdMMCO{op: op}
				switch op {
				case 1, 2, 4, 6:
					m.a = r.ue()
				case 3:
					m.a, m.b = r.ue(), r.ue()
				}
				s.mmco[s.numMMCO] = m
				s.numMMCO++
			}
		}
	}
	if pps.cabac && !s.isIntra() {
		s.cabacInitIdc = r.ue()
	}
	s.qpDelta = r.se()
	if s.sliceType == vdSliceSP || s.sliceType == vdSliceSI {
		if s.sliceType == vdSliceSP {
			r.bit()
		}
		r.se()
	}
	if pps.deblockingControl {
		if s.disableDeblock = r.ue(); s.disableDeblock != 1 {
			s.alpha, s.beta = r.se(), r.se()
		}
	}
	if r.over {
		return false
	}
	s.dataBitOffset = r.pos + 8
	return true
}

func (s *vdSlice) readWeights(r *vdBits) {
	w := &s.weights
	w.lumaDenom = r.ue()
	w.chromaDenom = r.ue()
	if w.lumaDenom > 7 || w.chromaDenom > 7 {
		r.over = true
		return
	}
	for list := 0; list < 1+b2i(s.isB()); list++ {
		for i := 0; i < s.numRef[list]; i++ {
			w.lw[list][i] = int16(1 << w.lumaDenom)
			w.cw[list][i] = [2]int16{int16(1 << w.chromaDenom), int16(1 << w.chromaDenom)}
			if r.flag() {
				w.luma[list] = true
				w.lw[list][i], w.lo[list][i] = int16(r.se()), int16(r.se())
			}
			if r.flag() {
				w.chroma[list] = true
				for j := 0; j < 2; j++ {
					w.cw[list][i][j], w.co[list][i][j] = int16(r.se()), int16(r.se())
				}
			}
		}
	}
}
