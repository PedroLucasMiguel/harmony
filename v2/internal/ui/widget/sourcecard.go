package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	sourceBorder   = 2
	sourceMetaPadY = 9
	sourceMetaPadX = 11
	sourceLabel    = 13
)

// SourceCard is something to share: a small picture over its name, as the picker lists screens, windows and cameras.
type SourceCard struct {
	Name     string
	Detail   string
	Thumb    *Surface
	NoThumb  bool
	Selected bool
	OnClick  func()
}

func (k *SourceCard) metaHeight() float32 { return sourceLabel*1.5 + 2*sourceMetaPadY }

func (k *SourceCard) Measure(c *Context, maxWidth float32) geom.Size {
	h := k.metaHeight() + 2*sourceBorder
	if !k.NoThumb {
		h += (maxWidth - 2*sourceBorder) * 9 / 16
	}
	return geom.Size{W: maxWidth, H: h}
}

func (k *SourceCard) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r)
	border := c.Theme.Border
	switch {
	case k.Selected:
		border = c.Theme.Accent
	case hovered:
		border = c.Theme.BorderStrong
	}
	c.Paint.Fill(r, c.Theme.Radius, c.Theme.Surface)
	c.Paint.PushClip(r)
	inner := r.InsetAll(sourceBorder)
	if !k.NoThumb {
		area := geom.Rect{X: inner.X, Y: inner.Y, W: inner.W, H: inner.W * 9 / 16}
		c.Paint.Fill(area, 0, c.Theme.Bg)
		if k.Thumb != nil && k.Thumb.live {
			if w, h := k.Thumb.Size(); w > 0 && h > 0 {
				fit := area
				if float32(w)*area.H > float32(h)*area.W {
					fit.H = area.W * float32(h) / float32(w)
					fit.Y += (area.H - fit.H) / 2
				} else {
					fit.W = area.H * float32(w) / float32(h)
					fit.X += (area.W - fit.W) / 2
				}
				c.Paint.Texture(k.Thumb.tex, fit, false)
			}
		}
		inner.Y += area.H
		inner.H -= area.H
	}
	st := paint.TextStyle{Size: sourceLabel, Weight: paint.Regular}
	label := k.Name
	meta := geom.Rect{X: inner.X + sourceMetaPadX, Y: inner.Y, W: inner.W - 2*sourceMetaPadX, H: inner.H}
	if k.Detail != "" {
		label += "  ·  " + k.Detail
	}
	c.Paint.TextIn(meta, label, meta.X, meta.Y+sourceMetaPadY, sourceLabel*1.5, st, c.Theme.Text)
	c.Paint.PopClip()
	c.Paint.Stroke(r, c.Theme.Radius, sourceBorder, border)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			if k.OnClick != nil {
				k.OnClick()
			}
		}
	}
}
