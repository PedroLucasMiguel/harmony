package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	badgeSmall      = 24
	badgeLarge      = 72
	badgeEmojiShare = 0.77
	badgeEmojiLine  = 1.2
)

// BadgeFace is a badge's picture, or its emoji when it has none, in a square.
type BadgeFace struct {
	Picture *paint.Picture
	Emoji   string
	Large   bool
}

func (b BadgeFace) side() float32 {
	if b.Large {
		return badgeLarge
	}
	return badgeSmall
}

func (b BadgeFace) Measure(*Context, float32) geom.Size { return geom.Size{W: b.side(), H: b.side()} }

func (b BadgeFace) Draw(c *Context, r geom.Rect) {
	side := b.side()
	box := geom.Rect{X: r.X, Y: r.Y, W: side, H: side}
	if b.Picture != nil {
		c.Paint.DrawPicture(b.Picture, box, 0, false, c.Theme.Surface)
		return
	}
	if b.Emoji == "" {
		return
	}
	style := paint.TextStyle{Size: side * badgeEmojiShare, Weight: paint.Regular}
	line := style.Size * badgeEmojiLine
	width := c.Paint.TextWidth(b.Emoji, style)
	c.Paint.Text(b.Emoji, box.X+(box.W-width)/2, box.Y+(box.H-line)/2, line, style, c.Theme.Text)
}
