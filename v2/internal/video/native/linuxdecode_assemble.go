package native

// Picture assembly of the VA-API decoder, apart from the VA-API itself: access units in, decoded pictures to a sink in
// output order. It splits the units into NAL units, keeps the parameter sets, groups slices into pictures, keeps the
// picture buffer, and starts over at the next key frame when the stream loses its place. A sink does the hardware work.

import (
	"fmt"
	"sync/atomic"
)

// vdSink is what the assembler needs from the hardware side.
type vdSink interface {
	// open sets up decoding of the sequence and returns its surfaces, closing the previous sequence.
	open(sps *vdSPS, surfaces int) ([]vaSurfaceID, error)
	// decode submits one picture to the surface.
	decode(target vaSurfaceID, pic *vaPictureParameterBufferH264, iq *vaIQMatrixBufferH264, sl *vdSlices) error
	// show hands over the picture of the surface, in output order. It reports an error when the surface cannot be read.
	show(sps *vdSPS, surface vaSurfaceID) error
	// behind reports that more access units wait, so that pictures may be dropped instead of shown late.
	behind() bool
}

// vdSlices are the slices of the picture being assembled: parameters, and the NAL units they refer to.
type vdSlices struct {
	params []vaSliceParameterBufferH264
	data   []byte
	sizes  []int
}

func (s *vdSlices) reset() {
	s.params, s.data, s.sizes = s.params[:0], s.data[:0], s.sizes[:0]
}

func (s *vdSlices) add(p *vaSliceParameterBufferH264, nal []byte) {
	s.params = append(s.params, *p)
	s.data = append(s.data, nal...)
	s.sizes = append(s.sizes, len(nal))
}

type vdAssembler struct {
	sink    vdSink
	log     func(msg string)
	needKey atomic.Bool

	sets    vdSets
	dpb     vdDPB
	nals    [][]byte
	rbsp    []byte
	hdr     vdSlice
	first   vdSlice
	lists   [2][32]*vdFrame
	sp      vaSliceParameterBufferH264
	pic     vaPictureParameterBufferH264
	iq      vaIQMatrixBufferH264
	slices  vdSlices
	active  bool
	opened  *vdSPS
	sps     *vdSPS
	pps     *vdPPS
	waitIDR bool
	sawB    bool
	lastErr string
}

func newVDAssembler(sink vdSink, log func(string)) *vdAssembler {
	a := &vdAssembler{sink: sink, log: log, waitIDR: true}
	a.needKey.Store(true)
	return a
}

func (a *vdAssembler) logOnce(format string, args ...any) {
	if msg := fmt.Sprintf(format, args...); msg != a.lastErr {
		a.lastErr = msg
		a.log(msg)
	}
}

// lose drops what is being decoded and waits for the next key frame.
func (a *vdAssembler) lose() {
	a.waitIDR = true
	a.needKey.Store(true)
	a.active = false
	a.slices.reset()
	a.dpb.clear()
}

// write takes one access unit.
func (a *vdAssembler) write(au []byte) {
	defer func() {
		if r := recover(); r != nil {
			a.logOnce("damaged stream: %v", r)
			a.lose()
		}
	}()
	a.nals = vdSplit(au, a.nals)
	for _, nal := range a.nals {
		switch nal[0] & 31 {
		case 7:
			if err := a.sets.addSPS(nal); err != nil {
				a.logOnce("%v", err)
			}
		case 8:
			a.sets.addPPS(nal)
		case 1, 5:
			a.slice(nal)
		}
	}
	a.endPicture()
}

func (a *vdAssembler) slice(nal []byte) {
	typ, ref := int(nal[0]&31), int(nal[0]>>5&3)
	if a.waitIDR && typ != 5 {
		return
	}
	a.rbsp = vdUnescape(a.rbsp, nal[1:])
	pps, sps := a.sets.find(vdSliceIDs(a.rbsp))
	if pps == nil {
		return
	}
	if !parseSlice(&a.hdr, a.rbsp, typ, ref, pps, sps) {
		a.logOnce("a slice this decoder cannot take (interlaced fields or a damaged header)")
		a.lose()
		return
	}
	if a.hdr.redundant > 0 {
		return
	}
	if a.active && vdNewPicture(&a.first, &a.hdr) {
		a.endPicture()
		if a.waitIDR && typ != 5 {
			return
		}
	}
	if !a.active && !a.startPicture(sps, pps) {
		return
	}
	if len(a.slices.params) >= 64 || !a.dpb.buildLists(&a.hdr, &a.lists) {
		a.lose()
		return
	}
	vdFillSlice(&a.sp, &a.hdr, &a.lists, len(nal))
	a.slices.add(&a.sp, nal)
}

func (a *vdAssembler) startPicture(sps *vdSPS, pps *vdPPS) bool {
	h := &a.hdr
	if h.idr {
		if err := a.activate(sps); err != nil {
			a.logOnce("%v", err)
			a.lose()
			return false
		}
		a.flushOutput()
		a.dpb.clear()
		a.waitIDR = false
	} else if a.opened != sps || a.dpb.gap(h) {
		a.lose()
		return false
	}
	f := a.dpb.free()
	if f == nil {
		if o := a.dpb.popOutput(); o != nil {
			a.show(o)
		}
		f = a.dpb.free()
	}
	if f == nil {
		a.lose()
		return false
	}
	a.dpb.begin(h, f)
	a.first = *h
	a.sps, a.pps = sps, pps
	a.active = true
	a.slices.reset()
	a.sawB = a.sawB || h.isB()
	return true
}

// activate makes the decoding fit the sequence parameter set, starting a new sequence when the picture size or the
// stream's settings changed.
func (a *vdAssembler) activate(sps *vdSPS) error {
	if a.opened == sps {
		return nil
	}
	if a.opened != nil {
		a.flushOutput()
		a.opened = nil
	}
	pool := max(sps.numRefFrames, 1) + 2
	if sps.pocType != 2 {
		pool += 3
		if sps.hasReorder {
			pool += sps.numReorder - 3
		}
	}
	surfaces, err := a.sink.open(sps, min(pool, 32))
	if err != nil {
		return err
	}
	a.opened = sps
	a.dpb.reset(sps, surfaces)
	a.sawB = false
	return nil
}

func (a *vdAssembler) endPicture() {
	if !a.active {
		return
	}
	a.active = false
	h := &a.first
	cur := a.dpb.cur
	if len(a.slices.params) == 0 {
		a.lose()
		return
	}
	vdFillPicture(&a.pic, &a.dpb, a.sps, a.pps, h)
	vdFillIQMatrix(&a.iq, a.pps)
	if err := a.sink.decode(cur.surface, &a.pic, &a.iq, &a.slices); err != nil {
		a.logOnce("%v", err)
		a.lose()
		return
	}
	if h.hasMMCO5() {
		a.flushOutput()
	}
	a.dpb.finish(h)
	cur.waiting = true
	a.dpb.release(cur)
	a.needKey.Store(false)
	for a.dpb.numWaiting() > a.reorderDepth() {
		a.show(a.dpb.popOutput())
	}
}

// reorderDepth is how many pictures wait for output so that B frames come out in order.
func (a *vdAssembler) reorderDepth() int {
	switch {
	case a.sps.pocType == 2:
		return 0
	case a.sps.hasReorder:
		return a.sps.numReorder
	case a.sawB:
		return min(max(a.sps.numRefFrames, 1), 4)
	}
	return 0
}

func (a *vdAssembler) flushOutput() {
	for f := a.dpb.popOutput(); f != nil; f = a.dpb.popOutput() {
		a.show(f)
	}
}

func (a *vdAssembler) show(f *vdFrame) {
	if !a.sink.behind() {
		if err := a.sink.show(a.opened, f.surface); err != nil {
			a.logOnce("%v", err)
			a.lose()
			return
		}
	}
	a.dpb.release(f)
}
