package widget

import (
	"image/color"
	"strings"

	"harmony/v2/internal/markdown"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	emojiImage  = 1.35
	emojiDrop   = 0.25
	emojiMargin = 0.05
	bigScale    = 1.9
	bigLine     = 1.2
	bigImage    = 1.5
)

// InlineEmoji is what a :name: stands for: a character, or a picture (Key names it in the picture cache, Fetch gets it).
type InlineEmoji struct {
	Char  string
	Key   string
	Fetch func() ([]byte, error)
}

// EmojiFunc resolves a lower case :name: (without the colons).
type EmojiFunc func(name string) (InlineEmoji, bool)

type inlineImage struct {
	r      geom.Rect
	key    string
	fetch  func() ([]byte, error)
	after  int
	alt    string
	breaks uint8
}

// emojiSpan lays a :name: out as a character or a picture, and says whether the name was one.
func (f *flow) emojiSpan(s *markdown.Span, size float32) bool {
	if f.out.emoji == nil {
		return false
	}
	e, ok := f.out.emoji(strings.ToLower(s.Text[1 : len(s.Text)-1]))
	if !ok {
		return false
	}
	if e.Char != "" {
		s.Text, s.Flags = e.Char, s.Flags&^markdown.Emoji
		f.span(*s, size, 0, inkText)
		return true
	}
	edge := size * emojiImage
	if f.big > 0 {
		edge = size * bigImage
	}
	margin := size * emojiMargin
	if f.started && f.x+edge+2*margin > f.x0+f.w {
		f.newLine()
	}
	style := paint.TextStyle{Size: size, Weight: paint.Regular}
	top := f.y + (f.lh-edge)/2
	if f.big == 0 {
		baseline := f.y + (f.lh-f.c.Paint.ContentHeight(style))/2 + f.c.Paint.Ascent(style)
		top = baseline + size*emojiDrop - edge
	}
	f.flush()
	f.out.images = append(f.out.images, inlineImage{r: geom.Rect{X: f.x + margin, Y: top, W: edge, H: edge}, key: e.Key, fetch: e.Fetch, after: len(f.out.frags), alt: s.Text, breaks: f.breaks})
	f.breaks = 0
	f.x += edge + 2*margin
	f.started = true
	return true
}

func (r *RichText) drawImages(c *Context, x, y float32) {
	for _, im := range r.images {
		pic := c.Paint.Picture(im.key, im.fetch)
		w, h, ok := pic.Size()
		if !ok {
			continue
		}
		box := geom.Rect{X: x + im.r.X, Y: y + im.r.Y, W: im.r.W, H: im.r.H}
		if w > h {
			box.Y, box.H = box.Y+box.H*(1-float32(h)/float32(w))/2, box.H*float32(h)/float32(w)
		} else if h > w {
			box.X, box.W = box.X+box.W*(1-float32(w)/float32(h))/2, box.W*float32(w)/float32(h)
		}
		c.Paint.DrawPicture(pic, box, 0, false, color.RGBA{})
	}
}

// hasPicture says whether a block holds a :name: that is drawn as a picture.
func (r *RichText) hasPicture(b markdown.Block) bool {
	if r.emoji == nil {
		return false
	}
	for _, line := range b.Lines {
		for _, s := range line {
			if s.Flags&markdown.Emoji == 0 {
				continue
			}
			if e, ok := r.emoji(strings.ToLower(s.Text[1 : len(s.Text)-1])); ok && e.Char == "" {
				return true
			}
		}
	}
	return false
}
