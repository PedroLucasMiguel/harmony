package widget

import (
	"time"

	"harmony/v2/internal/ui/redraw"
)

const blinkHalfPeriod = 500 * time.Millisecond

var epoch = time.Now()

// SetWindowActive tells the context whether the window is focused and not minimised; a caret blinks only in one that is.
func (c *Context) SetWindowActive(active bool) {
	c.active = active
}

// Blink is the caret's phase; it asks for a frame when the phase next flips. A window that is not active shows no caret.
func (c *Context) Blink() bool {
	if !c.active {
		return false
	}
	elapsed := time.Since(epoch)
	redraw.After(blinkHalfPeriod - elapsed%blinkHalfPeriod)
	return elapsed/blinkHalfPeriod%2 == 0
}
