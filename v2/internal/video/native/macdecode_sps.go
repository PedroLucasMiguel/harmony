//go:build darwin

// Annex B splitting and the parts of the H.264 sequence parameter set the decoder needs: the picture size and how its
// colours are coded.
package native

import "bytes"

const (
	nalSlice = 1
	nalIDR   = 5
	nalSPS   = 7
	nalPPS   = 8
)

var mdecStartCode = []byte{0, 0, 1}

// mdecSplit appends the NAL units of an Annex B access unit to nals, without their start codes.
func mdecSplit(au []byte, nals [][]byte) [][]byte {
	at := bytes.Index(au, mdecStartCode)
	for at >= 0 {
		start := at + 3
		next := bytes.Index(au[start:], mdecStartCode)
		end := len(au)
		if next >= 0 {
			end = start + next
		}
		nal := au[start:end]
		for len(nal) > 0 && nal[len(nal)-1] == 0 {
			nal = nal[:len(nal)-1]
		}
		if len(nal) > 0 {
			nals = append(nals, nal)
		}
		if next < 0 {
			break
		}
		at = end
	}
	return nals
}

// mdecPicture is what a sequence parameter set says.
type mdecPicture struct {
	w, h int
	// matrix is the H.273 matrix code, 2 when the stream does not say; full is only meaningful when tagged.
	matrix int
	full   bool
	tagged bool
}

type mdecBits struct {
	b   []byte
	pos int
}

func (r *mdecBits) bit() int {
	i := r.pos >> 3
	r.pos++
	if i >= len(r.b) {
		return 0
	}
	return int(r.b[i]>>(7-(r.pos-1)&7)) & 1
}

func (r *mdecBits) bits(n int) int {
	v := 0
	for ; n > 0; n-- {
		v = v<<1 | r.bit()
	}
	return v
}

func (r *mdecBits) ue() int {
	zeros := 0
	for r.bit() == 0 && zeros < 32 {
		zeros++
	}
	return 1<<zeros - 1 + r.bits(zeros)
}

func (r *mdecBits) se() int {
	v := r.ue()
	if v&1 == 1 {
		return (v + 1) / 2
	}
	return -v / 2
}

func (r *mdecBits) skipScaling(size int) {
	last, next := 8, 8
	for i := 0; i < size && next != 0; i++ {
		next = (last + r.se() + 256) % 256
		if next != 0 {
			last = next
		}
	}
}

// mdecParseSPS reads a sequence parameter set NAL unit (with its header byte). ok is false when it does not parse.
func mdecParseSPS(nal []byte) (p mdecPicture, ok bool) {
	if len(nal) < 5 {
		return p, false
	}
	b := make([]byte, 0, len(nal))
	for i := 1; i < len(nal); i++ {
		if i >= 3 && nal[i] == 3 && nal[i-1] == 0 && nal[i-2] == 0 {
			continue
		}
		b = append(b, nal[i])
	}
	r := &mdecBits{b: b}
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
					r.skipScaling(size)
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
		for n := r.ue(); n > 0 && n < 256; n-- {
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
	p = mdecPicture{w: w, h: h, matrix: 2}
	if r.bit() == 1 {
		if r.bit() == 1 && r.bits(8) == 255 {
			r.bits(32)
		}
		if r.bit() == 1 {
			r.bit()
		}
		if r.bit() == 1 {
			r.bits(3)
			p.full = r.bit() == 1
			p.tagged = true
			if r.bit() == 1 {
				r.bits(16)
				p.matrix = r.bits(8)
			}
		}
	}
	return p, w > 0 && h > 0 && w <= 16384 && h <= 16384 && r.pos>>3 <= len(b)+1
}
