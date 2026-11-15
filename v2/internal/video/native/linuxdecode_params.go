package native

// The VA-API decode parameter buffers of H.264, filled from the parameter sets, the slice header and the picture buffer.

func vdPicture(f *vdFrame, flags uint32) vaPictureH264 {
	idx := f.frameNum
	if f.ref == vdRefLong {
		idx = f.longIdx
	}
	return vaPictureH264{PictureID: f.surface, FrameIdx: uint32(idx), Flags: flags, TopFieldOrderCnt: int32(f.top), BottomFieldOrderCnt: int32(f.bot)}
}

func vdRefFlags(f *vdFrame) uint32 {
	if f.ref == vdRefLong {
		return vaPictureH264LongTermRef
	}
	return vaPictureH264ShortTermRef
}

func vdFillPicture(p *vaPictureParameterBufferH264, d *vdDPB, sps *vdSPS, pps *vdPPS, h *vdSlice) {
	*p = vaPictureParameterBufferH264{
		PictureWidthInMbsMinus1:   uint16(sps.mbsW - 1),
		PictureHeightInMbsMinus1:  uint16(sps.mbsH - 1),
		NumRefFrames:              uint8(sps.numRefFrames),
		PicInitQpMinus26:          int8(pps.initQp - 26),
		PicInitQsMinus26:          int8(pps.initQs - 26),
		ChromaQpIndexOffset:       int8(pps.chromaQpOffset),
		SecondChromaQpIndexOffset: int8(pps.chromaQpOffset2),
		FrameNum:                  uint16(h.frameNum),
	}
	u := func(v bool, shift uint) uint32 { return uint32(b2i(v)) << shift }
	p.SeqFields = 1<<vaDecSeqChromaFormatIdc | u(sps.gaps, vaDecSeqGapsInFrameNum) | u(sps.frameMbsOnly, vaDecSeqFrameMbsOnly) |
		u(sps.mbaff, vaDecSeqMbAdaptive) | u(sps.direct8x8, vaDecSeqDirect8x8Inference) | u(sps.level >= 31, vaDecSeqMinLumaBiPred) |
		uint32(sps.log2MaxFrameNum-4)<<vaDecSeqLog2MaxFrameNum | uint32(sps.pocType)<<vaDecSeqPocType |
		uint32(max(sps.log2MaxPocLsb-4, 0))<<vaDecSeqLog2MaxPocLsb | u(sps.deltaPocAlwaysZero, vaDecSeqDeltaPocAlwaysZero)
	p.PicFields = u(pps.cabac, vaDecPicEntropyCoding) | u(pps.weightedPred, vaDecPicWeightedPred) |
		uint32(pps.weightedBipredIdc)<<vaDecPicWeightedBipredIdc | u(pps.transform8x8, vaDecPicTransform8x8) |
		u(pps.constrainedIntra, vaDecPicConstrainedIntra) | u(pps.bottomPocPresent, vaDecPicOrderPresent) |
		u(pps.deblockingControl, vaDecPicDeblockingControl) | u(pps.redundantPicCnt, vaDecPicRedundantPicCnt) |
		u(h.nalRefIdc != 0, vaDecPicReferencePic)

	var flags uint32
	if h.nalRefIdc != 0 {
		flags = vaPictureH264ShortTermRef
	}
	p.CurrPic = vdPicture(d.cur, flags)
	p.CurrPic.FrameIdx = uint32(h.frameNum)
	n := 0
	for i := range d.frames {
		f := &d.frames[i]
		if f != d.cur && f.ref != vdRefNone && n < len(p.ReferenceFrames) {
			p.ReferenceFrames[n] = vdPicture(f, vdRefFlags(f))
			n++
		}
	}
	for ; n < len(p.ReferenceFrames); n++ {
		p.ReferenceFrames[n] = vaInvalidPicture()
	}
}

func vdFillIQMatrix(q *vaIQMatrixBufferH264, pps *vdPPS) {
	*q = vaIQMatrixBufferH264{}
	for i := range q.ScalingList4x4 {
		for k, v := range pps.lists.l4[i] {
			q.ScalingList4x4[i][vdZigzag4[k]] = v
		}
	}
	for i := range q.ScalingList8x8 {
		for k, v := range pps.lists.l8[i] {
			q.ScalingList8x8[i][vdZigzag8[k]] = v
		}
	}
}

func vdFillSlice(sp *vaSliceParameterBufferH264, h *vdSlice, lists *[2][32]*vdFrame, dataSize int) {
	*sp = vaSliceParameterBufferH264{
		SliceDataSize:             uint32(dataSize),
		SliceDataFlag:             vaSliceDataFlagAll,
		SliceDataBitOffset:        uint16(h.dataBitOffset),
		FirstMbInSlice:            uint16(h.firstMb),
		SliceType:                 uint8(h.sliceType),
		DirectSpatialMvPredFlag:   uint8(b2i(h.directSpatial)),
		NumRefIdxL0ActiveMinus1:   uint8(max(h.numRef[0]-1, 0)),
		NumRefIdxL1ActiveMinus1:   uint8(max(h.numRef[1]-1, 0)),
		CabacInitIdc:              uint8(h.cabacInitIdc),
		SliceQpDelta:              int8(h.qpDelta),
		DisableDeblockingFilterID: uint8(h.disableDeblock),
		SliceAlphaC0Offset:        int8(h.alpha),
		SliceBetaOffset:           int8(h.beta),
		LumaLog2WeightDenom:       uint8(h.weights.lumaDenom),
		ChromaLog2WeightDenom:     uint8(h.weights.chromaDenom),
	}
	vdFillList(&sp.RefPicList0, &lists[0], h.numRef[0])
	vdFillList(&sp.RefPicList1, &lists[1], h.numRef[1])
	w := &h.weights
	sp.LumaWeightL0Flag, sp.ChromaWeightL0Flag = uint8(b2i(w.luma[0])), uint8(b2i(w.chroma[0]))
	sp.LumaWeightL1Flag, sp.ChromaWeightL1Flag = uint8(b2i(w.luma[1])), uint8(b2i(w.chroma[1]))
	sp.LumaWeightL0, sp.LumaOffsetL0, sp.ChromaWeightL0, sp.ChromaOffsetL0 = w.lw[0], w.lo[0], w.cw[0], w.co[0]
	sp.LumaWeightL1, sp.LumaOffsetL1, sp.ChromaWeightL1, sp.ChromaOffsetL1 = w.lw[1], w.lo[1], w.cw[1], w.co[1]
}

// vdFillList writes the frames of a reference list; a picture the stream refers to and the decoder does not have is left
// out, as the other decoders do, and the end of the list is invalid.
func vdFillList(out *[32]vaPictureH264, list *[32]*vdFrame, count int) {
	n := 0
	for _, f := range list[:count] {
		if f != nil {
			out[n] = vdPicture(f, vdRefFlags(f))
			n++
		}
	}
	for ; n < len(out); n++ {
		out[n] = vaInvalidPicture()
	}
}
