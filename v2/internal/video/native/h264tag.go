package native

import (
	"bytes"
	"math/bits"
)

// Makes an encoder's Annex B output what the stream contract says whatever the encoder wrote: the colour coding in the
// SPS VUI (and no frame reordering there), and SPS and PPS in front of every key frame. Pure Go, shared by the platforms
// whose encoders do not tag their own streams.

var fixStartCode4 = []byte{0, 0, 0, 1}

const (
	fixNalIDR = 5
	fixNalSPS = 7
	fixNalPPS = 8
)

// streamFixer rewrites access units. It keeps the last SPS and PPS it saw so that a key frame that came without them gets
// them. out is reused: the result of fix is valid until the next call.
type streamFixer struct {
	matrix   int
	sps, pps []byte // with start code
	out      []byte
	scratch  []byte
}

// fix returns au with the SPS tagged and parameter sets before the first IDR slice. Access units that are not Annex B
// come back unchanged.
func (f *streamFixer) fix(au []byte) []byte {
	f.out = f.out[:0]
	sawParams := false
	for i := 0; i < len(au); {
		start, hdr := fixNextStartCode(au, i)
		if start < 0 {
			if i == 0 {
				return au
			}
			break
		}
		end := len(au)
		if next, _ := fixNextStartCode(au, hdr+1); next >= 0 {
			end = next
		}
		nal := au[hdr:end]
		for len(nal) > 0 && nal[len(nal)-1] == 0 {
			nal = nal[:len(nal)-1]
		}
		switch nalType := nal[0] & 0x1f; nalType {
		case fixNalSPS:
			tagged := tagSPS(&f.scratch, nal, f.matrix)
			f.sps = append(append(f.sps[:0], fixStartCode4...), tagged...)
			f.out = append(f.out, f.sps...)
			sawParams = true
		case fixNalPPS:
			f.pps = append(append(f.pps[:0], fixStartCode4...), nal...)
			f.out = append(f.out, f.pps...)
			sawParams = true
		case fixNalIDR:
			if !sawParams && len(f.sps) > 0 && len(f.pps) > 0 {
				f.out = append(append(f.out, f.sps...), f.pps...)
			}
			sawParams = true
			f.out = append(append(f.out, fixStartCode4...), nal...)
		default:
			f.out = append(append(f.out, fixStartCode4...), nal...)
		}
		i = end
	}
	return f.out
}

// fixNextStartCode finds the next 0 0 1 at or after from; hdr is the index of the NAL header byte after it, start the index
// of the start code, -1 when there is none.
func fixNextStartCode(b []byte, from int) (start, hdr int) {
	at := bytes.Index(b[from:], fixStartCode3)
	if at < 0 || from+at+3 >= len(b) {
		return -1, -1
	}
	return from + at, from + at + 3
}

var fixStartCode3 = []byte{0, 0, 1}

// spsWriter appends bits to a byte slice.
type spsWriter struct {
	b []byte
	n int // bits written in the last byte
}

func (w *spsWriter) bit(v int) {
	if w.n == 0 {
		w.b = append(w.b, 0)
	}
	w.b[len(w.b)-1] |= byte(v&1) << (7 - w.n)
	w.n = (w.n + 1) & 7
}

func (w *spsWriter) bits(v, n int) {
	for i := n - 1; i >= 0; i-- {
		w.bit(v >> i)
	}
}

func (w *spsWriter) ue(v int) {
	v++
	n := 0
	for t := v; t > 1; t >>= 1 {
		n++
	}
	w.bits(0, n)
	w.bits(v, n+1)
}

// spsReader reads bits from an RBSP.
type spsReader struct {
	b   []byte
	pos int
	bad bool
}

func (r *spsReader) bit() int {
	if r.pos>>3 >= len(r.b) {
		r.bad = true
		return 0
	}
	v := int(r.b[r.pos>>3]>>(7-r.pos&7)) & 1
	r.pos++
	return v
}

func (r *spsReader) bits(n int) int {
	v := 0
	for ; n > 0; n-- {
		v = v<<1 | r.bit()
	}
	return v
}

func (r *spsReader) ue() int {
	zeros := 0
	for r.bit() == 0 {
		if zeros++; zeros > 31 || r.bad {
			r.bad = true
			return 0
		}
	}
	return 1<<zeros - 1 + r.bits(zeros)
}

// spsCopyBits, spsCopyUE and copySE move a field from r to w and return its value.
func spsCopyBits(r *spsReader, w *spsWriter, n int) int {
	v := r.bits(n)
	w.bits(v, n)
	return v
}

func spsCopyUE(r *spsReader, w *spsWriter) int {
	v := r.ue()
	w.ue(v)
	return v
}

// unescapeNAL removes the emulation prevention bytes of a NAL payload.
func unescapeNAL(dst, nal []byte) []byte {
	dst = dst[:0]
	zeros := 0
	for _, c := range nal {
		if zeros >= 2 && c == 3 {
			zeros = 0
			continue
		}
		if c == 0 {
			zeros++
		} else {
			zeros = 0
		}
		dst = append(dst, c)
	}
	return dst
}

func escapeNAL(dst, rbsp []byte) []byte {
	zeros := 0
	for _, c := range rbsp {
		if zeros >= 2 && c <= 3 {
			dst = append(dst, 3)
			zeros = 0
		}
		dst = append(dst, c)
		if c == 0 {
			zeros++
		} else {
			zeros = 0
		}
	}
	return dst
}

// spsColourDescription is what the VUI carries for a matrix code: primaries, transfer and matrix, H.273 numbers. BT.601 is
// the 625 line set (5) for primaries and the BT.709 transfer curve, which is the same curve (1 is BT.709, 6 SMPTE 170M).
func spsColourDescription(matrix int) (primaries, transfer, mat int) {
	if matrix == BT709 {
		return 1, 1, 1
	}
	return 6, 6, 6
}

func spsHighProfile(p int) bool {
	switch p {
	case 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135:
		return true
	}
	return false
}

// tagSPS returns the SPS NAL unit (header byte included, no start code) with the VUI's video signal type set to limited
// range and the colour description of matrix, and a bitstream restriction without reordering when it had no VUI. The
// result is built in *scratch. An SPS it cannot parse comes back as it was.
func tagSPS(scratch *[]byte, nal []byte, matrix int) []byte {
	rbsp := unescapeNAL(nil, nal[1:])
	end := len(rbsp)
	for end > 0 && rbsp[end-1] == 0 {
		end--
	}
	if end == 0 {
		return nal
	}
	stop := (end-1)*8 + 7 - bits.TrailingZeros8(rbsp[end-1])
	r := &spsReader{b: rbsp}
	w := &spsWriter{b: make([]byte, 0, len(rbsp)+16)}
	profile := spsCopyBits(r, w, 8)
	spsCopyBits(r, w, 16)
	spsCopyUE(r, w)
	if spsHighProfile(profile) {
		if chroma := spsCopyUE(r, w); chroma == 3 {
			spsCopyBits(r, w, 1)
		}
		spsCopyUE(r, w)
		spsCopyUE(r, w)
		spsCopyBits(r, w, 1)
		if spsCopyBits(r, w, 1) == 1 {
			return nal
		}
	}
	spsCopyUE(r, w)
	switch spsCopyUE(r, w) {
	case 0:
		spsCopyUE(r, w)
	case 1:
		spsCopyBits(r, w, 1)
		for i := 0; i < 2; i++ {
			spsCopyUE(r, w) // se(v) has the same shape as ue(v) on the wire
		}
		for n := spsCopyUE(r, w); n > 0; n-- {
			spsCopyUE(r, w)
		}
	}
	refs := spsCopyUE(r, w)
	spsCopyBits(r, w, 1)
	spsCopyUE(r, w)
	spsCopyUE(r, w)
	if spsCopyBits(r, w, 1) == 0 {
		spsCopyBits(r, w, 1)
	}
	spsCopyBits(r, w, 1)
	if spsCopyBits(r, w, 1) == 1 {
		for i := 0; i < 4; i++ {
			spsCopyUE(r, w)
		}
	}
	hasVUI := r.bit()
	if r.bad {
		return nal
	}
	w.bit(1)
	primaries, transfer, mat := spsColourDescription(matrix)
	writeSignal := func() {
		w.bit(1)
		w.bits(5, 3) // video_format: unspecified
		w.bit(0)     // limited range
		w.bit(1)
		w.bits(primaries, 8)
		w.bits(transfer, 8)
		w.bits(mat, 8)
	}
	if hasVUI == 0 {
		w.bit(0) // aspect_ratio_info_present_flag
		w.bit(0) // overscan_info_present_flag
		writeSignal()
		w.bit(0) // chroma_loc_info_present_flag
		w.bit(0) // timing_info_present_flag
		w.bit(0) // nal_hrd_parameters_present_flag
		w.bit(0) // vcl_hrd_parameters_present_flag
		w.bit(0) // pic_struct_present_flag
		w.bit(1) // bitstream_restriction_flag
		w.bit(1) // motion_vectors_over_pic_boundaries_flag
		w.ue(2)  // max_bytes_per_pic_denom
		w.ue(1)  // max_bits_per_mb_denom
		w.ue(16) // log2_max_mv_length_horizontal
		w.ue(16) // log2_max_mv_length_vertical
		w.ue(0)  // max_num_reorder_frames
		w.ue(max(refs, 1))
	} else {
		if spsCopyBits(r, w, 1) == 1 {
			if spsCopyBits(r, w, 8) == 255 {
				spsCopyBits(r, w, 32)
			}
		}
		if spsCopyBits(r, w, 1) == 1 {
			spsCopyBits(r, w, 1)
		}
		if r.bit() == 1 {
			r.bits(4)
			if r.bit() == 1 {
				r.bits(24)
			}
		}
		writeSignal()
		for r.pos < stop && !r.bad {
			w.bit(r.bit())
		}
	}
	if r.bad || r.pos > stop+1 {
		return nal
	}
	w.bit(1)
	for w.n != 0 {
		w.bit(0)
	}
	out := append((*scratch)[:0], nal[0])
	out = escapeNAL(out, w.b)
	*scratch = out
	return out
}
