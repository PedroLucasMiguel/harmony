package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	switchWidth       = 40
	switchHeight      = 22.4
	switchKnob        = 16
	switchKnobInset   = 3.2
	switchTravel      = 17.6
	switchOffAlpha    = 0.2
	switchSeconds     = 0.15
	switchShadowAlpha = 102
)

// Switch is an on/off toggle that slides between its two positions.
type Switch struct {
	On       bool
	Disabled bool
	OnChange func(bool)

	slide Ease
	shown bool
}

func (s *Switch) Measure(*Context, float32) geom.Size {
	return geom.Size{W: switchWidth, H: switchHeight}
}

// Toggle flips the switch as a click on it would.
func (s *Switch) Toggle() {
	if s.Disabled {
		return
	}
	s.On = !s.On
	if s.OnChange != nil {
		s.OnChange(s.On)
	}
}

func (s *Switch) Draw(c *Context, r geom.Rect) {
	if c.Hovered(r) && !s.Disabled {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			s.Toggle()
		}
	}
	s.paint(c, r)
}

// paint draws the switch only, for a row that takes the click itself.
func (s *Switch) paint(c *Context, r geom.Rect) {
	target := float32(0)
	if s.On {
		target = 1
	}
	if !s.shown {
		s.slide.Value, s.shown = target, true
	}
	t := s.slide.Toward(c, target, switchSeconds)
	c.Paint.Fill(r, r.H/2, theme.Mix(theme.WithAlpha(c.Theme.Tint, switchOffAlpha), c.Theme.Accent, Smooth(t)))
	knob := geom.Rect{X: r.X + switchKnobInset + switchTravel*Smooth(t), Y: r.Y + (r.H-switchKnob)/2, W: switchKnob, H: switchKnob}
	c.Paint.Shadow(knob, switchKnob/2, 1, 3, color.RGBA{A: switchShadowAlpha})
	c.Paint.Fill(knob, switchKnob/2, theme.Mix(c.Theme.Text, ToneOnAccent.Color(c.Theme), Smooth(t)))
}
