package channels

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	pictureTop    = 4.8
	pictureMaxW   = 420
	pictureMaxH   = 320
	embedCloseBox = 24
	embedCloseGap = 4.8
	embedCloseIco = 14.4
)

// pictureEmbed is the card of a link that is a picture: the picture, once it has arrived, and nothing before.
func pictureEmbed(e *embedLayout, p *hclient.LinkPreview, w float32, pw, ph int, ready bool) *embedLayout {
	e.top = pictureTop
	if !ready || p.ImageHash == "" {
		return e
	}
	scale := min(1, min(pictureMaxW, w)/float32(pw), pictureMaxH/float32(ph))
	e.picture = geom.Rect{W: float32(pw) * scale, H: float32(ph) * scale}
	e.height = e.picture.H
	return e
}

func (s *Screen) drawPictureEmbed(c *widget.Context, e *embedLayout, x, y float32) {
	r := geom.Rect{X: x, Y: y + e.top, W: e.picture.W, H: e.picture.H}
	pic := c.Paint.PictureFrom(e.preview.ImageHash, s.Session.Chat())
	c.Paint.DrawPicture(pic, r, embedRadius, false, theme.Mix(c.Theme.Bg, c.Theme.Tint, embedFill))
	if c.Hovered(r) {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.Clicked(r) {
			c.Claim()
			rl.OpenURL(e.preview.URL)
		}
	}
}

func embedCloseRect(card geom.Rect) geom.Rect {
	return geom.Rect{X: card.Right() - embedCloseGap - embedCloseBox, Y: card.Y + embedCloseGap, W: embedCloseBox, H: embedCloseBox}
}

// embedClose closes a link card for good when its close button is pressed.
func (s *Screen) embedClose(c *widget.Context, l *entryLayout, card geom.Rect) bool {
	btn := embedCloseRect(card)
	if !c.Hovered(card) || !c.Clicked(btn) {
		return false
	}
	c.Claim()
	l.embedGone = true
	s.Settings.DismissEmbed(l.embedKey)
	return true
}

// drawEmbedClose draws the close button over a card the pointer is on.
func (s *Screen) drawEmbedClose(c *widget.Context, card geom.Rect) {
	if !c.Hovered(card) {
		return
	}
	btn := embedCloseRect(card)
	ink := c.Theme.Muted
	if c.Hovered(btn) {
		c.SetCursor(rl.MouseCursorPointingHand)
		ink = c.Theme.Text
	}
	c.Paint.Fill(btn, 6, c.Theme.Surface)
	c.Paint.Icon("x", geom.Rect{X: btn.X + (btn.W-embedCloseIco)/2, Y: btn.Y + (btn.H-embedCloseIco)/2, W: embedCloseIco, H: embedCloseIco}, ink)
}
