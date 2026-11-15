// What the Windows decoder reads from an Annex B access unit: whether it has an IDR slice, and what its sequence
// parameter set says of the picture size and how the colours are coded.
// Pure Go, so it builds everywhere and its tests run anywhere.

package native

import "bytes"

var winStartCode = []byte{0, 0, 1}

// winNALs calls fn with the type and the bytes after the NAL header of each NAL unit of an Annex B access unit; fn
// returns false to stop.
func winNALs(au []byte, fn func(typ int, body []byte) bool) {
	at := bytes.Index(au, winStartCode)
	for at >= 0 {
		start := at + 3
		next := bytes.Index(au[start:], winStartCode)
		end := len(au)
		if next >= 0 {
			end = start + next
		}
		if start < end && !fn(int(au[start]&0x1f), au[start+1:end]) {
			return
		}
		if next < 0 {
			return
		}
		at = end
	}
}

// winIsIDR reports whether the access unit has an IDR slice; it does not allocate.
func winIsIDR(au []byte) bool {
	for i := 0; ; {
		at := bytes.Index(au[i:], winStartCode)
		if at < 0 || i+at+3 >= len(au) {
			return false
		}
		i += at + 3
		if au[i]&0x1f == 5 {
			return true
		}
	}
}

// winSPS is what a sequence parameter set says.
type winSPS struct {
	w, h int
	// matrix is the H.273 matrix code, 2 when the stream does not say; fullTagged is true when the stream says whether the
	// range is full, and full is then the answer.
	matrix     int
	fullTagged bool
	full       bool
}

// winFindSPS reads the first sequence parameter set of the access unit, without allocating.
func winFindSPS(au []byte) (sps winSPS, ok bool) {
	winNALs(au, func(typ int, body []byte) bool {
		if typ == 7 {
			sps, ok = winParseSPS(body)
			return false
		}
		return true
	})
	return
}

type winBits struct {
	b   []byte
	pos int
}

func (r *winBits) bit() int {
	i := r.pos >> 3
	r.pos++
	if i >= len(r.b) {
		return 0
	}
	return int(r.b[i]>>(7-(r.pos-1)&7)) & 1
}

func (r *winBits) bits(n int) int {
	v := 0
	for ; n > 0; n-- {
		v = v<<1 | r.bit()
	}
	return v
}

func (r *winBits) ue() int {
	zeros := 0
	for r.bit() == 0 && zeros < 32 {
		zeros++
	}
	return 1<<zeros - 1 + r.bits(zeros)
}

func (r *winBits) se() int {
	v := r.ue()
	if v&1 == 1 {
		return (v + 1) / 2
	}
	return -v / 2
}

func (r *winBits) skipScalingList(size int) {
	last, next := 8, 8
	for i := 0; i < size && next != 0; i++ {
		next = (last + r.se() + 256) % 256
		if next != 0 {
			last = next
		}
	}
}

// winParseSPS takes the bytes after the NAL header.
func winParseSPS(rbsp []byte) (winSPS, bool) {
	var buf [256]byte
	b := buf[:0]
	for i := 0; i < len(rbsp) && len(b) < len(buf); i++ {
		if i >= 2 && rbsp[i] == 3 && rbsp[i-1] == 0 && rbsp[i-2] == 0 {
			continue
		}
		b = append(b, rbsp[i])
	}
	r := &winBits{b: b}
	profile := r.bits(8)
	r.bits(16)
	r.ue()
	chroma := 1
	switch profile {
	case 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135:
		if chroma = r.ue(); chroma == 3 {
			r.bit()
		}
		r.ue()
		r.ue()
		r.bit()
		if r.bit() == 1 {
			lists := 8
			if chroma == 3 {
				lists = 12
			}
			for i := 0; i < lists; i++ {
				if r.bit() == 1 {
					size := 64
					if i < 6 {
						size = 16
					}
					r.skipScalingList(size)
				}
			}
		}
	}
	r.ue()
	switch r.ue() {
	case 0:
		r.ue()
	case 1:
		r.bit()
		r.se()
		r.se()
		for n := r.ue(); n > 0; n-- {
			r.se()
		}
	}
	r.ue()
	r.bit()
	mbsW, mapH := r.ue()+1, r.ue()+1
	frameOnly := r.bit()
	if frameOnly == 0 {
		r.bit()
	}
	r.bit()
	w, h := mbsW*16, mapH*16*(2-frameOnly)
	if r.bit() == 1 {
		unitX, unitY := 1, 2-frameOnly
		if chroma == 1 || chroma == 2 {
			unitX = 2
		}
		if chroma == 1 {
			unitY *= 2
		}
		w -= unitX * (r.ue() + r.ue())
		h -= unitY * (r.ue() + r.ue())
	}
	sps := winSPS{w: w, h: h, matrix: 2}
	if r.bit() == 1 {
		if r.bit() == 1 && r.bits(8) == 255 {
			r.bits(32)
		}
		if r.bit() == 1 {
			r.bit()
		}
		if r.bit() == 1 {
			r.bits(3)
			sps.fullTagged, sps.full = true, r.bit() == 1
			if r.bit() == 1 {
				r.bits(16)
				sps.matrix = r.bits(8)
			}
		}
	}
	if w <= 0 || h <= 0 || r.pos>>3 > len(b)+1 {
		return winSPS{}, false
	}
	return sps, true
}

// winColour is how the stream codes colour: what its parameter set says, else what the caller said, else the way Chromium
// reads a stream that does not say (BT.709 above 640 wide, BT.601 below). BT.2020 is read as BT.709, the closer of the two
// matrices this client has.
func winColour(sps winSPS, haveSPS bool, p DecodeParams, width int) (matrix int, full bool) {
	code := 2
	if haveSPS {
		code = sps.matrix
	}
	switch code {
	case 2, 0:
		code = p.Matrix
	}
	switch code {
	case 1, 9, 10:
		matrix = BT709
	case 5, 6:
		matrix = BT601
	default:
		matrix = BT601
		if width > 640 {
			matrix = BT709
		}
	}
	full = p.Full
	if haveSPS && sps.fullTagged {
		full = sps.full
	}
	return
}
