package emojitext

import (
	"encoding/binary"
	"io"
	"os"

	"github.com/go-text/typesetting/font"
)

type sbixStrike struct {
	ppem   float32
	offset int64
}

// sbix reads PNG glyphs straight from the font file, because the table is 190 MB in Apple Color Emoji and only a few kilobytes are ever wanted.
type sbix struct {
	file    *os.File
	strikes []sbixStrike
}

// CoreText draws Apple's glyphs this far (in ems) below where their origin offset puts them.
const sbixDrop = 0.125

const (
	sbixHeader       = 8
	sbixStrikeHeader = 4
	sbixGlyphHeader  = 8
)

func openSbix(file *os.File, table, length int64) (*sbix, error) {
	var header [sbixHeader]byte
	if _, err := file.ReadAt(header[:], table); err != nil {
		return nil, err
	}
	offsets := make([]byte, 4*binary.BigEndian.Uint32(header[4:]))
	if _, err := file.ReadAt(offsets, table+sbixHeader); err != nil {
		return nil, err
	}
	s := &sbix{file: file}
	for i := 0; i < len(offsets); i += 4 {
		start := table + int64(binary.BigEndian.Uint32(offsets[i:]))
		var strike [2]byte
		if _, err := file.ReadAt(strike[:], start); err != nil {
			return nil, err
		}
		s.strikes = append(s.strikes, sbixStrike{ppem: float32(binary.BigEndian.Uint16(strike[:])), offset: start})
	}
	if len(s.strikes) == 0 || length == 0 {
		return nil, io.ErrUnexpectedEOF
	}
	return s, nil
}

// ranked puts the strikes in the order to try them: the smallest at least as large as the size wanted first, so glyphs are mostly scaled down, then the larger ones, then the smaller ones from the nearest down.
func (s *sbix) ranked(px float32) []sbixStrike {
	out := make([]sbixStrike, 0, len(s.strikes))
	for _, k := range s.strikes {
		if k.ppem >= px {
			out = append(out, k)
		}
	}
	for i := len(s.strikes) - 1; i >= 0; i-- {
		if s.strikes[i].ppem < px {
			out = append(out, s.strikes[i])
		}
	}
	return out
}

func (s *sbix) bitmap(f *Font, gid font.GID, px float32) *Bitmap {
	for _, strike := range s.ranked(px) {
		if data, x, y, ok := s.glyph(strike, gid, 0); ok {
			return placed(data, float32(x), float32(y)-sbixDrop*strike.ppem, px/strike.ppem)
		}
	}
	return nil
}

func (s *sbix) glyph(strike sbixStrike, gid font.GID, depth int) (png []byte, originX, originY int16, ok bool) {
	var span [8]byte
	if _, err := s.file.ReadAt(span[:], strike.offset+sbixStrikeHeader+4*int64(gid)); err != nil {
		return nil, 0, 0, false
	}
	from, to := int64(binary.BigEndian.Uint32(span[:])), int64(binary.BigEndian.Uint32(span[4:]))
	if to-from <= sbixGlyphHeader {
		return nil, 0, 0, false
	}
	record := make([]byte, to-from)
	if _, err := s.file.ReadAt(record, strike.offset+from); err != nil {
		return nil, 0, 0, false
	}
	originX, originY = int16(binary.BigEndian.Uint16(record)), int16(binary.BigEndian.Uint16(record[2:]))
	switch string(record[4:8]) {
	case "png ":
		return record[sbixGlyphHeader:], originX, originY, true
	case "dupe":
		if depth == 0 && len(record) >= sbixGlyphHeader+2 {
			return s.glyph(strike, font.GID(binary.BigEndian.Uint16(record[sbixGlyphHeader:])), 1)
		}
	}
	return nil, 0, 0, false
}

// placed scales a PNG glyph by scale and puts its lower left corner at (x, y) font pixels above the baseline.
func placed(data []byte, x, y, scale float32) *Bitmap {
	src, ok := decode(data)
	if !ok {
		return nil
	}
	w, h := max(round(float32(src.Rect.Dx())*scale), 1), max(round(float32(src.Rect.Dy())*scale), 1)
	return &Bitmap{Pix: straight(resize(src, w, h)), W: w, H: h, Left: float32(round(x * scale)), Top: -float32(round(y*scale) + h)}
}
