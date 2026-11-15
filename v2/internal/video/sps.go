package video

import (
	"bytes"
	"fmt"
)

// PictureSize reads the picture size from the sequence parameter set at the start of an access unit; 0, 0 when it has none.
func PictureSize(au []byte) (w, h int) {
	p := ParsePicture(au)
	return p.W, p.H
}

// ParsePicture reads what the sequence parameter set at the start of an access unit says of the picture: its size and
// how its colours are coded. The zero Picture when there is no parameter set.
func ParsePicture(au []byte) Picture {
	head := au[:min(len(au), 256)]
	for i := 0; ; {
		at := bytes.Index(head[i:], startCode3)
		if at < 0 || i+at+3 >= len(head) {
			return Picture{}
		}
		i += at + 3
		if head[i]&0x1f == 7 {
			end := len(au)
			if next := bytes.Index(au[i:], startCode3); next >= 0 {
				end = i + next
			}
			return parseSPS(au[i+1 : end])
		}
	}
}

// ProfileLevelID is the profile-level-id of an access unit's sequence parameter set as the SDP writes it: profile_idc,
// the constraint flags and the level, with the level mapped to the two the engine registers (1f up to 3.1, else 28; 1f
// for baseline). It is "" when the access unit has no parameter set.
func ProfileLevelID(au []byte) string {
	head := au[:min(len(au), 256)]
	for i := 0; ; {
		at := bytes.Index(head[i:], startCode3)
		if at < 0 || i+at+3+3 >= len(head) {
			return ""
		}
		i += at + 3
		if head[i]&0x1f == 7 {
			profile, flags, level := head[i+1], head[i+2], head[i+3]
			if profile == 66 || level <= 0x1f {
				level = 0x1f
			} else {
				level = 0x28
			}
			return fmt.Sprintf("%02x%02x%02x", profile, flags, level)
		}
	}
}

// IsKeyframe reports whether the access unit has an IDR slice.
func IsKeyframe(au []byte) bool {
	for i := 0; ; {
		at := bytes.Index(au[i:], startCode3)
		if at < 0 || i+at+3 >= len(au) {
			return false
		}
		i += at + 3
		if au[i]&0x1f == 5 {
			return true
		}
	}
}

type bitReader struct {
	b   []byte
	pos int
}

func (r *bitReader) bit() int {
	if r.pos>>3 >= len(r.b) {
		r.pos++
		return 0
	}
	v := int(r.b[r.pos>>3]>>(7-r.pos&7)) & 1
	r.pos++
	return v
}

func (r *bitReader) bits(n int) int {
	v := 0
	for ; n > 0; n-- {
		v = v<<1 | r.bit()
	}
	return v
}

func (r *bitReader) ue() int {
	zeros := 0
	for r.bit() == 0 && zeros < 32 {
		zeros++
	}
	return 1<<zeros - 1 + r.bits(zeros)
}

func (r *bitReader) se() int {
	v := r.ue()
	if v&1 == 1 {
		return (v + 1) / 2
	}
	return -v / 2
}

func (r *bitReader) skipScalingList(size int) {
	last, next := 8, 8
	for i := 0; i < size && next != 0; i++ {
		next = (last + r.se() + 256) % 256
		if next != 0 {
			last = next
		}
	}
}

// parseSPS takes the bytes after the NAL header.
func parseSPS(rbsp []byte) Picture {
	b := make([]byte, 0, len(rbsp))
	for i := 0; i < len(rbsp); i++ {
		if i >= 2 && rbsp[i] == 3 && rbsp[i-1] == 0 && rbsp[i-2] == 0 {
			continue
		}
		b = append(b, rbsp[i])
	}
	r := &bitReader{b: b}
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
	matrix, full := r.vui()
	if w <= 0 || h <= 0 || r.pos>>3 > len(b)+1 {
		return Picture{}
	}
	return Picture{W: w, H: h, Colour: coding(matrix, full, w)}
}

// vui reads the colour description in the video usability information; the matrix is 2 (unspecified) when there is none.
func (r *bitReader) vui() (matrix int, full bool) {
	matrix = 2
	if r.bit() == 0 {
		return
	}
	if r.bit() == 1 && r.bits(8) == 255 {
		r.bits(32)
	}
	if r.bit() == 1 {
		r.bit()
	}
	if r.bit() == 1 {
		r.bits(3)
		full = r.bit() == 1
		if r.bit() == 1 {
			r.bits(16)
			matrix = r.bits(8)
		}
	}
	return
}
