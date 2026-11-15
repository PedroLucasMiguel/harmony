package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	badgeIconSize  = 24
	badgeEmojiSize = 18.4
)

// BadgeIcon is a server badge: its picture when it has one, else its emoji.
type BadgeIcon struct {
	Emoji string
	Hash  string
	// Size is the side in CSS pixels; zero is the small one.
	Size float32
}

func (b BadgeIcon) side() float32 {
	if b.Size > 0 {
		return b.Size
	}
	return badgeIconSize
}

func (b BadgeIcon) Measure(*Context, float32) geom.Size {
	return geom.Size{W: b.side(), H: b.side()}
}

func (b BadgeIcon) Draw(c *Context, r geom.Rect) {
	box := geom.Rect{X: r.X, Y: r.Y + (r.H-b.side())/2, W: b.side(), H: b.side()}
	if b.Hash != "" && c.Faces != nil {
		if pic := c.Paint.PictureFrom(b.Hash, c.Faces); pic.State() == paint.PictureReady {
			c.Paint.DrawPicture(pic, box, 0, false, c.Theme.Surface)
			return
		}
	}
	emoji := badgeEmojiSize * b.side() / badgeIconSize
	style := paint.TextStyle{Size: emoji, Weight: paint.Regular}
	width := c.Paint.TextWidth(b.Emoji, style)
	c.Paint.Text(b.Emoji, box.X+(box.W-width)/2, box.Y+(box.H-emoji*1.5)/2, emoji*1.5, style, c.Theme.Text)
}
