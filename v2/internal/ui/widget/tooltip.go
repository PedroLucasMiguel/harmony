package widget

import (
	"time"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/theme"
)

const (
	tipPadX   = 7.2
	tipPadY   = 3.2
	tipRadius = 5
	tipSize   = 11.52
	tipLine   = 13.8
	tipGap    = 5.6
	tipEdge   = 0.14
	tipMargin = 4
)

// Tooltip is the small label that appears over something the pointer rests on. One serves a whole screen: it follows whatever
// asked for it last, so rows and buttons all call Show every frame they draw and only the one under the pointer answers.
type Tooltip struct {
	since  time.Time
	frame  uint64
	anchor geom.Rect
	text   string
	c      *Context
	paint  func()
}

var tipStyle = paint.TextStyle{Size: tipSize, Weight: paint.Regular}

// Show draws text over the anchor once the pointer has rested on it for delay, or under it when there is no room above.
func (t *Tooltip) Show(c *Context, anchor geom.Rect, text string, delay time.Duration) {
	if text == "" || !c.Hovered(anchor) {
		return
	}
	if t.anchor != anchor || t.frame+1 != c.Frame {
		t.since, t.anchor = time.Now(), anchor
	}
	t.frame = c.Frame
	if wait := delay - time.Since(t.since); wait > 0 {
		redraw.After(wait)
		return
	}
	t.c, t.text = c, text
	if t.paint == nil {
		t.paint = t.draw
	}
	c.Overlay(t.paint)
}

func (t *Tooltip) draw() {
	c, anchor, text := t.c, t.anchor, t.text
	w := c.Paint.TextWidth(text, tipStyle) + 2*tipPadX
	box := geom.Rect{W: w, H: tipLine + 2*tipPadY}
	box.X = max(tipMargin, min(anchor.X, c.Viewport.W-w-tipMargin))
	box.Y = anchor.Y - tipGap - box.H
	if box.Y < tipMargin {
		box.Y = anchor.Bottom() + tipGap
	}
	c.Paint.Fill(box, tipRadius, c.Theme.Bg)
	c.Paint.Stroke(box, tipRadius, c.Hairline(), theme.WithAlpha(c.Theme.Tint, tipEdge))
	c.Paint.Text(text, box.X+tipPadX, box.Y+tipPadY, tipLine, tipStyle, c.Theme.Text)
}
