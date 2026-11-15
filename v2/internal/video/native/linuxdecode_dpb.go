package native

// The decoded picture buffer of the VA-API decoder: picture order counts, reference marking (sliding window and memory
// management operations), the reference picture lists of a slice, and the output order. Frames only, which is all that
// video calls send. The hardware decodes; the host keeps this book, as the VA-API demands.

const (
	vdRefNone = iota
	vdRefShort
	vdRefLong
)

// vdFrame is one slot of the picture buffer: a surface and what the stream has said of the picture in it.
type vdFrame struct {
	surface  vaSurfaceID
	frameNum int
	longIdx  int
	ref      int
	top, bot int
	waiting  bool
	busy     bool
}

func (f *vdFrame) poc() int { return min(f.top, f.bot) }

type vdDPB struct {
	frames          []vdFrame
	sps             *vdSPS
	maxLongIdx      int
	prevRefFrameNum int
	prevFrameNum    int
	prevFrameOffset int
	prevPocMsb      int
	prevPocLsb      int

	// the picture being decoded
	cur       *vdFrame
	pocMsb    int
	frameOffs int
}

func (d *vdDPB) reset(sps *vdSPS, surfaces []vaSurfaceID) {
	*d = vdDPB{sps: sps, maxLongIdx: -1, frames: make([]vdFrame, len(surfaces))}
	for i, s := range surfaces {
		d.frames[i].surface = s
	}
}

// clear forgets every picture, as a stream that lost its place does.
func (d *vdDPB) clear() {
	for i := range d.frames {
		d.frames[i].ref, d.frames[i].waiting, d.frames[i].busy = vdRefNone, false, false
	}
	d.maxLongIdx = -1
	d.cur = nil
}

func (d *vdDPB) free() *vdFrame {
	for i := range d.frames {
		if !d.frames[i].busy {
			return &d.frames[i]
		}
	}
	return nil
}

func (d *vdDPB) release(f *vdFrame) {
	f.busy = f.ref != vdRefNone || f.waiting || f == d.cur
}

// gap reports whether frame_num skips a picture the stream never sent.
func (d *vdDPB) gap(s *vdSlice) bool {
	if s.idr {
		return false
	}
	max := d.sps.maxFrameNum()
	return s.frameNum != d.prevRefFrameNum && s.frameNum != (d.prevRefFrameNum+1)%max
}

// begin takes a frame for the picture of this slice and works out its order counts (8.2.1).
func (d *vdDPB) begin(s *vdSlice, f *vdFrame) {
	sps := d.sps
	max := sps.maxFrameNum()
	d.cur = f
	f.busy, f.waiting, f.ref, f.frameNum, f.longIdx = true, false, vdRefNone, s.frameNum, -1
	if s.idr {
		d.prevFrameOffset, d.prevPocMsb, d.prevPocLsb = 0, 0, 0
	}
	switch sps.pocType {
	case 0:
		maxLsb := 1 << sps.log2MaxPocLsb
		msb := d.prevPocMsb
		switch {
		case s.pocLsb < d.prevPocLsb && d.prevPocLsb-s.pocLsb >= maxLsb/2:
			msb += maxLsb
		case s.pocLsb > d.prevPocLsb && s.pocLsb-d.prevPocLsb > maxLsb/2:
			msb -= maxLsb
		}
		d.pocMsb = msb
		f.top = msb + s.pocLsb
		f.bot = f.top + s.deltaPocBottom
	case 1:
		offs := d.prevFrameOffset
		if s.idr {
			offs = 0
		} else if d.prevFrameNum > s.frameNum {
			offs += max
		}
		d.frameOffs = offs
		n := len(sps.offsetRef)
		abs := 0
		if n > 0 {
			abs = offs + s.frameNum
		}
		if s.nalRefIdc == 0 && abs > 0 {
			abs--
		}
		expected := 0
		if abs > 0 {
			perCycle := 0
			for _, o := range sps.offsetRef {
				perCycle += o
			}
			expected = (abs - 1) / n * perCycle
			for i := 0; i <= (abs-1)%n; i++ {
				expected += sps.offsetRef[i]
			}
		}
		if s.nalRefIdc == 0 {
			expected += sps.offsetNonRef
		}
		f.top = expected + s.deltaPoc[0]
		f.bot = f.top + sps.offsetTopBottom + s.deltaPoc[1]
	default:
		offs := d.prevFrameOffset
		if s.idr {
			offs = 0
		} else if d.prevFrameNum > s.frameNum {
			offs += max
		}
		d.frameOffs = offs
		t := 2 * (offs + s.frameNum)
		if s.idr {
			t = 0
		} else if s.nalRefIdc == 0 {
			t--
		}
		f.top, f.bot = t, t
	}
}

func (d *vdDPB) frameNumWrap(f *vdFrame, cur int) int {
	if f.frameNum > cur {
		return f.frameNum - d.sps.maxFrameNum()
	}
	return f.frameNum
}

// buildLists makes the reference picture lists of a slice (8.2.4); false when the stream refers to a picture it does not
// have. Entries after the last picture are nil.
func (d *vdDPB) buildLists(s *vdSlice, out *[2][32]*vdFrame) bool {
	*out = [2][32]*vdFrame{}
	if s.isIntra() {
		return true
	}
	cur := d.cur
	var short, long [32]*vdFrame
	ns, nl := 0, 0
	for i := range d.frames {
		f := &d.frames[i]
		if f == cur {
			continue
		}
		switch f.ref {
		case vdRefShort:
			if ns < 32 {
				short[ns] = f
				ns++
			}
		case vdRefLong:
			if nl < 32 {
				long[nl] = f
				nl++
			}
		}
	}
	sortFrames(long[:nl], func(a, b *vdFrame) bool { return a.longIdx < b.longIdx })
	curPoc := min(cur.top, cur.bot)
	var init [2][64]*vdFrame
	var n [2]int
	if s.isB() {
		sortFrames(short[:ns], func(a, b *vdFrame) bool { return a.poc() > b.poc() })
		before := 0
		for before < ns && short[before].poc() > curPoc {
			before++
		}
		// short is in falling order: [0,before) come after the current picture, [before,ns) before it.
		// list 0: before the picture by falling POC, then after it by rising POC; list 1 the other way round
		for i := before; i < ns; i++ {
			init[0][n[0]] = short[i]
			n[0]++
		}
		for i := before - 1; i >= 0; i-- {
			init[0][n[0]] = short[i]
			n[0]++
		}
		for i := before - 1; i >= 0; i-- {
			init[1][n[1]] = short[i]
			n[1]++
		}
		for i := before; i < ns; i++ {
			init[1][n[1]] = short[i]
			n[1]++
		}
		for list := 0; list < 2; list++ {
			for i := 0; i < nl; i++ {
				init[list][n[list]] = long[i]
				n[list]++
			}
		}
		if n[1] > 1 && init[0] == init[1] {
			init[1][0], init[1][1] = init[1][1], init[1][0]
		}
	} else {
		sortFrames(short[:ns], func(a, b *vdFrame) bool { return d.frameNumWrap(a, s.frameNum) > d.frameNumWrap(b, s.frameNum) })
		for i := 0; i < ns; i++ {
			init[0][n[0]] = short[i]
			n[0]++
		}
		for i := 0; i < nl; i++ {
			init[0][n[0]] = long[i]
			n[0]++
		}
	}
	for list := 0; list < 1+b2i(s.isB()); list++ {
		count := s.numRef[list]
		var work [34]*vdFrame
		copy(work[:count], init[list][:min(n[list], count)])
		if !d.modify(s, list, &work, count) {
			return false
		}
		copy(out[list][:count], work[:count])
	}
	return true
}

func sortFrames(a []*vdFrame, less func(a, b *vdFrame) bool) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && less(a[j], a[j-1]); j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

// modify applies the reference picture list modification commands of a slice (8.2.4.3).
func (d *vdDPB) modify(s *vdSlice, list int, work *[34]*vdFrame, count int) bool {
	maxPicNum := d.sps.maxFrameNum()
	pred, idx := s.frameNum, 0
	for _, m := range s.mods[list][:s.numMods[list]] {
		var target *vdFrame
		if m.idc < 2 {
			abs := m.val + 1
			if m.idc == 0 {
				pred -= abs
				if pred < 0 {
					pred += maxPicNum
				}
			} else {
				pred += abs
				if pred >= maxPicNum {
					pred -= maxPicNum
				}
			}
			picNum := pred
			if picNum > s.frameNum {
				picNum -= maxPicNum
			}
			for i := range d.frames {
				f := &d.frames[i]
				if f != d.cur && f.ref == vdRefShort && d.frameNumWrap(f, s.frameNum) == picNum {
					target = f
				}
			}
		} else {
			for i := range d.frames {
				f := &d.frames[i]
				if f != d.cur && f.ref == vdRefLong && f.longIdx == m.val {
					target = f
				}
			}
		}
		if target == nil || idx >= count {
			return false
		}
		copy(work[idx+1:count+1], work[idx:count])
		work[idx] = target
		idx++
		next := idx
		for c := idx; c <= count; c++ {
			if work[c] != target {
				work[next] = work[c]
				next++
			}
		}
	}
	return true
}

// finish does what follows the decoding of the picture (8.2.5): reference marking, and the counts the next picture
// builds on. It reports whether the picture had a memory management operation 5.
func (d *vdDPB) finish(s *vdSlice) (mmco5 bool) {
	cur := d.cur
	sps := d.sps
	if s.idr {
		for i := range d.frames {
			if f := &d.frames[i]; f != cur {
				f.ref = vdRefNone
			}
		}
	}
	if s.nalRefIdc != 0 {
		switch {
		case s.idr:
			if s.longTermRef {
				cur.ref, cur.longIdx, d.maxLongIdx = vdRefLong, 0, 0
			} else {
				cur.ref, d.maxLongIdx = vdRefShort, -1
			}
		case s.adaptive:
			mmco5 = d.markAdaptive(s)
			if cur.ref == vdRefNone {
				cur.ref = vdRefShort
			}
		default:
			d.slidingWindow(s)
			cur.ref = vdRefShort
		}
	}
	for i := range d.frames {
		d.release(&d.frames[i])
	}
	if mmco5 {
		t := min(cur.top, cur.bot)
		cur.top -= t
		cur.bot -= t
	}
	d.prevFrameNum = s.frameNum
	d.prevFrameOffset = d.frameOffs
	if mmco5 {
		d.prevFrameNum, d.prevFrameOffset = 0, 0
	}
	if s.nalRefIdc != 0 {
		d.prevRefFrameNum = s.frameNum
		if mmco5 {
			d.prevRefFrameNum = 0
		}
		if sps.pocType == 0 {
			d.prevPocMsb, d.prevPocLsb = d.pocMsb, s.pocLsb
			if mmco5 {
				d.prevPocMsb, d.prevPocLsb = 0, cur.top
			}
		}
	}
	cur.frameNum = d.prevFrameNum
	d.cur = nil
	return mmco5
}

func (d *vdDPB) slidingWindow(s *vdSlice) {
	shorts, longs := 0, 0
	var oldest *vdFrame
	for i := range d.frames {
		f := &d.frames[i]
		if f == d.cur {
			continue
		}
		switch f.ref {
		case vdRefShort:
			shorts++
			if oldest == nil || d.frameNumWrap(f, s.frameNum) < d.frameNumWrap(oldest, s.frameNum) {
				oldest = f
			}
		case vdRefLong:
			longs++
		}
	}
	if shorts+longs >= max(d.sps.numRefFrames, 1) && oldest != nil {
		oldest.ref = vdRefNone
	}
}

func (d *vdDPB) markAdaptive(s *vdSlice) (mmco5 bool) {
	cur := d.cur
	for _, m := range s.mmco[:s.numMMCO] {
		switch m.op {
		case 1:
			if f := d.shortByPicNum(s, s.frameNum-(m.a+1)); f != nil {
				f.ref = vdRefNone
			}
		case 2:
			for i := range d.frames {
				if f := &d.frames[i]; f.ref == vdRefLong && f.longIdx == m.a {
					f.ref = vdRefNone
				}
			}
		case 3:
			f := d.shortByPicNum(s, s.frameNum-(m.a+1))
			d.dropLong(m.b, f)
			if f != nil {
				f.ref, f.longIdx = vdRefLong, m.b
			}
		case 4:
			d.maxLongIdx = m.a - 1
			for i := range d.frames {
				if f := &d.frames[i]; f.ref == vdRefLong && f.longIdx > d.maxLongIdx {
					f.ref = vdRefNone
				}
			}
		case 5:
			for i := range d.frames {
				if f := &d.frames[i]; f != cur {
					f.ref = vdRefNone
				}
			}
			d.maxLongIdx = -1
			mmco5 = true
		case 6:
			d.dropLong(m.a, cur)
			cur.ref, cur.longIdx = vdRefLong, m.a
		}
	}
	return mmco5
}

func (d *vdDPB) shortByPicNum(s *vdSlice, picNum int) *vdFrame {
	for i := range d.frames {
		f := &d.frames[i]
		if f != d.cur && f.ref == vdRefShort && d.frameNumWrap(f, s.frameNum) == picNum {
			return f
		}
	}
	return nil
}

func (d *vdDPB) dropLong(idx int, keep *vdFrame) {
	for i := range d.frames {
		if f := &d.frames[i]; f != keep && f.ref == vdRefLong && f.longIdx == idx {
			f.ref = vdRefNone
		}
	}
}

func (d *vdDPB) numWaiting() int {
	n := 0
	for i := range d.frames {
		n += b2i(d.frames[i].waiting)
	}
	return n
}

// popOutput takes the waiting frame that comes first in output order, nil when none waits.
func (d *vdDPB) popOutput() *vdFrame {
	var first *vdFrame
	for i := range d.frames {
		if f := &d.frames[i]; f.waiting && (first == nil || f.poc() < first.poc()) {
			first = f
		}
	}
	if first != nil {
		first.waiting = false
	}
	return first
}
