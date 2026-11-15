package widget

import "harmony/v2/internal/ui/redraw"

// Ease moves a value toward a target at a steady pace, and keeps frames coming while it moves.
type Ease struct{ Value float32 }

// Toward moves by Dt/seconds per unit of distance and returns the new value.
func (e *Ease) Toward(c *Context, target, seconds float32) float32 {
	step := c.Dt / seconds
	switch {
	case e.Value < target:
		e.Value = min(target, e.Value+step)
	case e.Value > target:
		e.Value = max(target, e.Value-step)
	}
	if e.Value != target {
		redraw.Request()
	}
	return e.Value
}

// Smooth bends a 0..1 progress into the slow-fast-slow curve of CSS transitions.
func Smooth(t float32) float32 { return t * t * (3 - 2*t) }
