package widget

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	scrollStep        = 48
	scrollbarWidth    = 10
	scrollbarInset    = 2
	scrollThumbMin    = 24
	scrollThumbAlpha  = 0.18
	scrollThumbHover  = 0.32
	scrollThumbActive = 0.45
)

type Scroll struct {
	Child Component
	// Bar shows a thumb down the right edge and keeps the content clear of it while there is more than fits.
	Bar bool
	// Overlay draws the thumb over the content instead of making room for it.
	Overlay bool

	offset  float32
	dragged bool
	grab    float32
}

// ScrollBy moves the content up by dy, for something that scrolls it on its own, as a drag near its edge does.
func (s *Scroll) ScrollBy(dy float32) { s.offset += dy }

func (s *Scroll) Measure(_ *Context, maxWidth float32) geom.Size { return geom.Size{W: maxWidth} }

func (s *Scroll) Draw(c *Context, r geom.Rect) {
	width := r.W
	content := s.Child.Measure(c, width).H
	bar := s.Bar && content > r.H
	if bar && !s.Overlay {
		width -= scrollbarWidth
		content = s.Child.Measure(c, width).H
	}
	if c.Hovered(r) {
		s.offset -= c.In.Wheel * scrollStep
	}
	if bar {
		s.dragThumb(c, r, content)
	}
	s.offset = min(max(s.offset, 0), max(0, content-r.H))
	c.Paint.PushClip(r)
	s.Child.Draw(c, geom.Rect{X: r.X, Y: r.Y - s.offset, W: width, H: content})
	c.Paint.PopClip()
	if bar {
		s.drawThumb(c, r, content)
	}
}

func (s *Scroll) thumb(r geom.Rect, content float32) geom.Rect {
	height := min(r.H, max(scrollThumbMin, r.H*r.H/content))
	travel := r.H - height
	y := r.Y
	if span := content - r.H; span > 0 {
		y += travel * s.offset / span
	}
	return geom.Rect{X: r.Right() - scrollbarWidth + scrollbarInset, Y: y, W: scrollbarWidth - 2*scrollbarInset, H: height}
}

func (s *Scroll) dragThumb(c *Context, r geom.Rect, content float32) {
	thumb := s.thumb(r, content)
	if c.Clicked(thumb) {
		c.Claim()
		s.dragged, s.grab = true, c.In.MouseY-thumb.Y
	}
	if !c.In.Down {
		s.dragged = false
	}
	if s.dragged {
		if travel := r.H - thumb.H; travel > 0 {
			s.offset = (c.In.MouseY - s.grab - r.Y) / travel * (content - r.H)
		}
	}
}

func (s *Scroll) drawThumb(c *Context, r geom.Rect, content float32) {
	thumb := s.thumb(r, content)
	alpha := float32(scrollThumbAlpha)
	switch {
	case s.dragged:
		alpha = scrollThumbActive
	case c.Hovered(thumb):
		alpha = scrollThumbHover
	}
	c.Paint.Fill(thumb, thumb.W/2, theme.WithAlpha(c.Theme.Tint, alpha))
}
