package paint

import (
	"github.com/go-text/typesetting/di"
	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/language"
	"github.com/go-text/typesetting/shaping"
	"golang.org/x/image/math/fixed"

	"harmony/v2/internal/ui/emojitext"
)

const (
	shapeScale     = 16
	shapeCacheSize = 1024
)

type glyph struct {
	id   font.GID
	x, y float32
}

type emojiGlyph struct {
	id font.GID
	x  float32
}

type run struct {
	glyphs []glyph
	emoji  []emojiGlyph
	width  float32
	face   *font.Face
	tf     *typeface
	place  placement
}

type runKey struct {
	text  string
	style TextStyle
}

type shaper struct {
	typefaces typefaces
	mono      *typeface
	italics   map[string]*typeface
	italic    map[Weight]*typeface
	families  [familyCount]*typeface
	cache     map[runKey]*run
	older     map[runKey]*run
	emoji     *emojitext.Font
	emojiTry  bool
}

func newShaper(tf typefaces) *shaper {
	return &shaper{typefaces: tf, mono: loadMono(), cache: map[runKey]*run{}}
}

func (s *shaper) typeface(style TextStyle) *typeface {
	if style.Family != FamilySystem && style.Family < familyCount {
		if s.families[style.Family] == nil {
			s.families[style.Family] = openFamily(style.Family)
		}
		if tf := s.families[style.Family]; tf != nil {
			return tf
		}
	}
	if style.Mono && s.mono != nil {
		return s.mono
	}
	if style.Italic {
		if tf := s.italicOf(style.Weight); tf != nil {
			return tf
		}
	}
	return s.typefaces[style.Weight]
}

// italicOf is the italic face of a weight, opened the first time somebody writes in italics.
func (s *shaper) italicOf(weight Weight) *typeface {
	tf, tried := s.italic[weight]
	if !tried {
		if s.italic == nil {
			s.italic, s.italics = map[Weight]*typeface{}, map[string]*typeface{}
		}
		tf = loadItalic(weight, s.italics)
		s.italic[weight] = tf
	}
	return tf
}

func (s *shaper) shape(text string, style TextStyle) *run {
	key := runKey{text, style}
	if r, ok := s.cache[key]; ok {
		return r
	}
	if r, ok := s.older[key]; ok {
		s.keep(key, r)
		return r
	}
	tf := s.typeface(style)
	r := &run{face: tf.variant(style.Weight, style.Size), tf: tf}
	runes := []rune(text)
	if emojitext.MayContain(text) && s.emojiFont() != nil {
		pen := float32(0)
		for _, seg := range emojitext.Segments(nil, text) {
			if seg.Emoji {
				pen = s.appendEmoji(r, string(runes[seg.From:seg.To]), style, pen)
			} else {
				pen = s.appendText(r, runes, seg.From, seg.To, style, pen)
			}
		}
		r.width = pen
	} else {
		r.width = s.appendText(r, runes, 0, len(runes), style, 0)
	}
	s.keep(key, r)
	return r
}

// keep remembers a run; when the cache is full it becomes the older one, which is still searched and from which what
// is used again moves back, so what a screen draws every frame stays while the rest is let go.
func (s *shaper) keep(key runKey, r *run) {
	if len(s.cache) >= shapeCacheSize {
		s.older, s.cache = s.cache, make(map[runKey]*run, shapeCacheSize)
	}
	s.cache[key] = r
}

func (s *shaper) emojiFont() *emojitext.Font {
	if !s.emojiTry {
		s.emojiTry, s.emoji = true, emojitext.Load()
	}
	return s.emoji
}

func (s *shaper) appendText(r *run, runes []rune, from, to int, style TextStyle, pen float32) float32 {
	var harfbuzz shaping.HarfbuzzShaper
	out := harfbuzz.Shape(shaping.Input{
		Text: runes, RunStart: from, RunEnd: to,
		Direction: di.DirectionLTR, Face: r.face, Script: language.Latin, Language: language.NewLanguage("en"),
		Size: fixed.Int26_6(style.Size * shapeScale * 64),
	})
	step := r.tf.tracking.perGlyph(style.Size) + style.Spacing
	for _, g := range out.Glyphs {
		r.glyphs = append(r.glyphs, glyph{
			id: g.GlyphID,
			x:  pen + float32(g.XOffset)/(64*shapeScale),
			y:  -float32(g.YOffset) / (64 * shapeScale),
		})
		pen += float32(g.Advance)/(64*shapeScale) + step
	}
	return pen
}

func (s *shaper) appendEmoji(r *run, cluster string, style TextStyle, pen float32) float32 {
	for _, g := range s.emoji.Shape(cluster) {
		if g.Advance == 0 {
			continue
		}
		r.emoji = append(r.emoji, emojiGlyph{id: g.ID, x: pen})
		pen += g.Advance*style.Size + r.tf.tracking.perGlyph(style.Size) + style.Spacing
	}
	return pen
}

func (s *shaper) verticalMetrics(style TextStyle) (ascent, descent float32) {
	tf := s.typeface(style)
	extents, _ := tf.variant(style.Weight, style.Size).FontHExtents()
	return extents.Ascender / tf.upem * style.Size, -extents.Descender / tf.upem * style.Size
}
