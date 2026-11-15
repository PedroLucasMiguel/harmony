package emojitext

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"runtime"

	"github.com/go-text/typesetting/di"
	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/font/opentype"
	"github.com/go-text/typesetting/language"
	"github.com/go-text/typesetting/shaping"
	"golang.org/x/image/math/fixed"
)

var systemFonts = map[string][]string{
	"darwin":  {"/System/Library/Fonts/Apple Color Emoji.ttc"},
	"windows": {`C:\Windows\Fonts\seguiemj.ttf`},
	"linux": {
		"/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
		"/usr/share/fonts/noto/NotoColorEmoji.ttf",
		"/usr/share/fonts/google-noto-color-emoji-fonts/NotoColorEmoji.ttf",
		"/usr/share/fonts/google-noto/NotoColorEmoji.ttf",
		"/usr/share/fonts/noto-color-emoji/NotoColorEmoji.ttf",
		"/usr/share/fonts/TTF/NotoColorEmoji.ttf",
		"/usr/share/fonts/google-noto-color-emoji-fonts/Noto-COLRv1.ttf",
	},
}

const (
	shapeEm       = 100
	shapeCacheMax = 512
)

// Font is the system's colour emoji font: it shapes clusters into glyphs and renders each glyph as a bitmap of the size asked for.
type Font struct {
	face   *font.Face
	upem   float32
	source source
	shaped map[string][]Glyph
	shaper shaping.HarfbuzzShaper
}

type source interface {
	bitmap(f *Font, gid font.GID, px float32) *Bitmap
}

// Glyph is one glyph of a shaped cluster; Advance is in ems.
type Glyph struct {
	ID      font.GID
	Advance float32
}

// Load opens the first emoji font the system has, or returns nil when it has none.
func Load() *Font {
	for _, path := range systemFonts[runtime.GOOS] {
		if f, err := open(path); err == nil {
			return f
		}
	}
	return nil
}

func open(path string) (*Font, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	loaders, err := opentype.NewLoaders(file)
	if err != nil || len(loaders) == 0 {
		file.Close()
		return nil, errors.Join(err, errors.New("no font"))
	}
	if loaders[0].HasTable(opentype.MustNewTag("sbix")) {
		return openSbixFont(file)
	}
	defer file.Close()
	face, err := font.ParseTTF(file)
	if err != nil {
		return nil, err
	}
	f := &Font{face: face, upem: float32(face.Upem()), shaped: map[string][]Glyph{}}
	switch {
	case face.COLR != nil:
		f.source = &layered{face: face, colr: face.COLR}
	case loaders[0].HasTable(opentype.MustNewTag("CBDT")):
		f.source = &embedded{face: face}
	default:
		return nil, errors.New("not a colour font")
	}
	return f, nil
}

// embedded draws CBDT glyphs: one PNG per glyph, spread over the advance and standing on the ascender.
type embedded struct{ face *font.Face }

func (e *embedded) bitmap(f *Font, gid font.GID, px float32) *Bitmap {
	data, ok := e.face.GlyphDataBitmap(gid)
	if !ok || data.Format != font.PNG {
		return nil
	}
	extents, _ := e.face.FontHExtents()
	scale := px * e.face.HorizontalAdvance(gid) / f.upem / float32(max(data.Width, 1))
	return placed(data.Data, 0, extents.Ascender*px/f.upem/scale-float32(data.Height), scale)
}

// The tables kept from a font whose sbix is too big to load: all that shaping needs.
var shapingTables = map[string]bool{
	"cmap": true, "head": true, "maxp": true, "hhea": true, "hmtx": true, "OS/2": true,
	"GSUB": true, "GDEF": true, "GPOS": true, "morx": true, "feat": true, "kern": true, "kerx": true,
}

// openSbixFont reads the first font of the file as an in-memory font without its sbix table.
func openSbixFont(file *os.File) (*Font, error) {
	var head [16]byte
	if _, err := file.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	start := int64(0)
	if string(head[:4]) == "ttcf" {
		start = int64(binary.BigEndian.Uint32(head[12:]))
	}
	if _, err := file.ReadAt(head[:12], start); err != nil {
		return nil, err
	}
	count := int(binary.BigEndian.Uint16(head[4:]))
	directory := make([]byte, 16*count)
	if _, err := file.ReadAt(directory, start+12); err != nil {
		return nil, err
	}
	var tables [][]byte
	var entries [][]byte
	var sbixOffset, sbixLength int64
	for i := 0; i < count; i++ {
		rec := directory[16*i : 16*i+16]
		offset, size := int64(binary.BigEndian.Uint32(rec[8:])), int64(binary.BigEndian.Uint32(rec[12:]))
		tag := string(rec[:4])
		if tag == "sbix" {
			sbixOffset, sbixLength = offset, size
		}
		if !shapingTables[tag] {
			continue
		}
		data := make([]byte, size+(-size&3))
		if _, err := file.ReadAt(data[:size], offset); err != nil {
			return nil, err
		}
		entries, tables = append(entries, rec), append(tables, data)
	}
	out := make([]byte, 12+16*len(entries))
	copy(out, head[:12])
	binary.BigEndian.PutUint16(out[4:], uint16(len(entries)))
	for i, rec := range entries {
		entry := out[12+16*i:]
		copy(entry, rec)
		binary.BigEndian.PutUint32(entry[8:], uint32(len(out)))
		out = append(out, tables[i]...)
	}
	loaders, err := opentype.NewLoaders(bytes.NewReader(out))
	if err != nil {
		return nil, err
	}
	parsed, err := font.NewFont(loaders[0])
	if err != nil {
		return nil, err
	}
	strikes, err := openSbix(file, sbixOffset, sbixLength)
	if err != nil {
		return nil, err
	}
	face := font.NewFace(parsed)
	return &Font{face: face, upem: float32(face.Upem()), source: strikes, shaped: map[string][]Glyph{}}, nil
}

// Shape returns the glyphs a cluster is drawn with: one for a sequence the font knows, several when it has to fall back to the parts.
func (f *Font) Shape(cluster string) []Glyph {
	if glyphs, ok := f.shaped[cluster]; ok {
		return glyphs
	}
	if len(f.shaped) >= shapeCacheMax {
		clear(f.shaped)
	}
	runes := []rune(cluster)
	out := f.shaper.Shape(shaping.Input{
		Text: runes, RunStart: 0, RunEnd: len(runes),
		Direction: di.DirectionLTR, Face: f.face, Script: language.Latin, Language: language.NewLanguage("en"),
		Size: fixed.Int26_6(shapeEm * 64),
	})
	glyphs := make([]Glyph, 0, len(out.Glyphs))
	for _, g := range out.Glyphs {
		glyphs = append(glyphs, Glyph{ID: g.GlyphID, Advance: float32(g.Advance) / (64 * shapeEm)})
	}
	f.shaped[cluster] = glyphs
	return glyphs
}

// Bitmap renders a glyph for text px device pixels tall, or nil when the font has no picture for it.
func (f *Font) Bitmap(id font.GID, px float32) *Bitmap { return f.source.bitmap(f, id, px) }

// Face identifies the font to caches that hold its glyphs.
func (f *Font) Face() *font.Face { return f.face }
