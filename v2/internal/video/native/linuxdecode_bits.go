package native

// The H.264 bit reader and Annex B helpers of the VA-API decoder: NAL splitting, emulation prevention removal and
// exp-Golomb codes. Pure Go, so the tests run everywhere.

import "bytes"

var vdStartCode = []byte{0, 0, 1}

// vdSplit appends the NAL units of an Annex B access unit to nals (start codes and trailing zero bytes cut off).
func vdSplit(au []byte, nals [][]byte) [][]byte {
	nals = nals[:0]
	start := -1
	for i := 0; ; {
		at := bytes.Index(au[i:], vdStartCode)
		if at < 0 {
			break
		}
		if start >= 0 {
			nals = vdAppendNAL(nals, au[start:i+at])
		}
		start = i + at + 3
		i = start
	}
	if start >= 0 {
		nals = vdAppendNAL(nals, au[start:])
	}
	return nals
}

func vdAppendNAL(nals [][]byte, nal []byte) [][]byte {
	for len(nal) > 0 && nal[len(nal)-1] == 0 {
		nal = nal[:len(nal)-1]
	}
	if len(nal) > 1 {
		nals = append(nals, nal)
	}
	return nals
}

// vdUnescape appends src to dst without the emulation prevention bytes (the 3 in 00 00 03).
func vdUnescape(dst, src []byte) []byte {
	dst = dst[:0]
	zeros := 0
	for _, b := range src {
		if zeros >= 2 && b == 3 {
			zeros = 0
			continue
		}
		if b == 0 {
			zeros++
		} else {
			zeros = 0
		}
		dst = append(dst, b)
	}
	return dst
}

// vdBits reads bits of an unescaped NAL payload; reading past the end sets over and yields zeros.
type vdBits struct {
	b    []byte
	pos  int
	over bool
}

func (r *vdBits) bit() int {
	i := r.pos >> 3
	if i >= len(r.b) {
		r.over = true
		return 0
	}
	v := int(r.b[i]>>(7-r.pos&7)) & 1
	r.pos++
	return v
}

func (r *vdBits) flag() bool { return r.bit() == 1 }

func (r *vdBits) bits(n int) int {
	v := 0
	for ; n > 0; n-- {
		v = v<<1 | r.bit()
	}
	return v
}

func (r *vdBits) skip(n int) { r.pos += n; r.over = r.over || r.pos > len(r.b)*8 }

func (r *vdBits) ue() int {
	zeros := 0
	for r.bit() == 0 {
		if zeros++; zeros > 31 || r.over {
			r.over = true
			return 0
		}
	}
	return 1<<zeros - 1 + r.bits(zeros)
}

func (r *vdBits) se() int {
	v := r.ue()
	if v&1 == 1 {
		return (v + 1) / 2
	}
	return -(v / 2)
}

// moreData is more_rbsp_data(): whether anything is left before the stop bit.
func (r *vdBits) moreData() bool {
	end := len(r.b)
	for end > 0 && r.b[end-1] == 0 {
		end--
	}
	if end == 0 {
		return false
	}
	last := r.b[end-1]
	stop := (end-1)*8 + 7
	for last&1 == 0 {
		last >>= 1
		stop--
	}
	return r.pos < stop
}
