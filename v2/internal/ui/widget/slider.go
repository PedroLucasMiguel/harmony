package widget

import (
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	sliderBox        = 18
	sliderTrack      = 6
	sliderThumb      = 18
	sliderRing       = 3
	sliderTrackAlpha = 0.18
	sliderGlowAlpha  = 0.3
	sliderGlow       = 4
	sliderHoverScale = 1.08
)

// Slider picks a whole number between Min and Max in steps. OnChange follows the thumb as it is dragged and OnCommit
// is called once when it is let go, or at once for a click.
type Slider struct {
	Min, Max, Step int
	Value          int
	OnChange       func(int)
	OnCommit       func(int)
	// Disabled shows the slider dimmed and leaves it alone.
	Disabled bool

	dragging bool
}

func (s *Slider) Measure(_ *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: sliderBox}
}

func (s *Slider) fraction() float32 {
	return float32(s.Value-s.Min) / float32(s.Max-s.Min)
}

func (s *Slider) valueAt(r geom.Rect, x float32) int {
	t := min(max((x-r.X-sliderThumb/2)/(r.W-sliderThumb), 0), 1)
	steps := math.Round(float64(t) * float64(s.Max-s.Min) / float64(s.Step))
	return s.Min + int(steps)*s.Step
}

func (s *Slider) Draw(c *Context, r geom.Rect) {
	hovered := c.Hovered(r) && !s.Disabled
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if hovered && c.In.Pressed {
		c.Claim()
		s.dragging = true
	}
	if s.dragging {
		if value := s.valueAt(r, c.In.MouseX); value != s.Value {
			s.Value = value
			if s.OnChange != nil {
				s.OnChange(value)
			}
		}
		if !c.In.Down {
			s.dragging = false
			if s.OnCommit != nil {
				s.OnCommit(s.Value)
			}
		}
	}

	track := geom.Rect{X: r.X, Y: r.Y + (r.H-sliderTrack)/2, W: r.W, H: sliderTrack}
	c.Paint.Fill(track, sliderTrack/2, fade(theme.WithAlpha(c.Theme.Tint, sliderTrackAlpha), s.Disabled))
	if fill := track.W * s.fraction(); fill > 0 {
		c.Paint.Fill(geom.Rect{X: track.X, Y: track.Y, W: fill, H: track.H}, sliderTrack/2, fade(c.Theme.Accent, s.Disabled))
	}

	size := float32(sliderThumb)
	if hovered || s.dragging {
		size *= sliderHoverScale
	}
	cx := r.X + sliderThumb/2 + s.fraction()*(r.W-sliderThumb)
	thumb := geom.Rect{X: cx - size/2, Y: r.Y + (r.H-size)/2, W: size, H: size}
	if s.dragging {
		c.Paint.Fill(thumb.InsetAll(-sliderGlow), size/2+sliderGlow, theme.WithAlpha(c.Theme.Accent, sliderGlowAlpha))
	}
	c.Paint.Fill(thumb, size/2, fade(c.Theme.Surface2, s.Disabled))
	c.Paint.Fill(thumb.InsetAll(sliderRing), size/2-sliderRing, fade(c.Theme.Accent, s.Disabled))
}
