package native

// A bit writer for H.264 headers with exp-Golomb codes. Bytes are written with emulation prevention once it is turned on,
// so what comes out can be handed to a hardware encoder as a packed header.

type vaBitWriter struct {
	buf   []byte
	cur   byte
	nbits uint
	zeros int
	epb   bool
}

func (w *vaBitWriter) reset(buf []byte) {
	*w = vaBitWriter{buf: buf[:0]}
}

func (w *vaBitWriter) rawByte(b byte) {
	if w.epb {
		if w.zeros >= 2 && b <= 3 {
			w.buf = append(w.buf, 3)
			w.zeros = 0
		}
		if b == 0 {
			w.zeros++
		} else {
			w.zeros = 0
		}
	}
	w.buf = append(w.buf, b)
}

func (w *vaBitWriter) bit(v uint32) {
	w.cur = w.cur<<1 | byte(v&1)
	if w.nbits++; w.nbits == 8 {
		w.rawByte(w.cur)
		w.cur, w.nbits = 0, 0
	}
}

func (w *vaBitWriter) bits(v uint32, n int) {
	for i := n - 1; i >= 0; i-- {
		w.bit(v >> uint(i))
	}
}

func (w *vaBitWriter) flag(b bool) {
	if b {
		w.bit(1)
	} else {
		w.bit(0)
	}
}

func (w *vaBitWriter) ue(v uint32) {
	v++
	n := 0
	for t := v; t > 1; t >>= 1 {
		n++
	}
	w.bits(0, n)
	w.bits(v, n+1)
}

func (w *vaBitWriter) se(v int32) {
	if v > 0 {
		w.ue(uint32(2*v - 1))
	} else {
		w.ue(uint32(-2 * v))
	}
}

// alignWith fills the rest of the byte with the given bit.
func (w *vaBitWriter) alignWith(v uint32) {
	for w.nbits != 0 {
		w.bit(v)
	}
}

// trailing writes rbsp_trailing_bits.
func (w *vaBitWriter) trailing() {
	w.bit(1)
	w.alignWith(0)
}

// bitLen is the number of bits written so far, the pending ones included.
func (w *vaBitWriter) bitLen() int { return len(w.buf)*8 + int(w.nbits) }

// finish pads a pending partial byte with zeros and returns the bytes.
func (w *vaBitWriter) finish() []byte {
	w.alignWith(0)
	return w.buf
}
