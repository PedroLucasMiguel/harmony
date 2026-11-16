package widget

import (
	"strconv"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	StreamBarHeight = 26
	barPadX         = 5.6
	barPadY         = 3.2
	barGap          = 4
	barIcon         = 14.4
	barPlate        = 0.1
	barPlateHover   = 0.18
	barCountAlpha   = 0.8
	barDimmed       = 0.35
	barBtnRadius    = 4
)

var (
	barCountStyle = paint.TextStyle{Size: 12, Weight: paint.Regular}
	barNoteStyle  = paint.TextStyle{Size: 12, Weight: paint.Regular}
)

// BarAction is what a press on a stream bar asked for.
type BarAction int

const (
	BarNone BarAction = iota
	BarPrev
	BarNext
	BarPop
	BarStage
	BarClose
	// BarGrab is a press on the bare bar, which the window is moved by.
	BarGrab
)

// StreamBar is the strip over a floating stream: step to the previous or next one with where it is among them, who is
// talking when that is why this one shows, and the buttons that pop the window out or in, put the streams back on the stage
// and close the window.
type StreamBar struct {
	// Index and Total place the stream shown among the streams; the arrows are off with fewer than two.
	Index, Total int
	Note         string
	// PopIcon is arrow-square-out to leave the app for a window of its own, or arrow-square-in to return to it.
	PopIcon string
	// Left keeps room clear for the system's own window buttons.
	Left float32
}

// Show draws the bar in r and reports what was pressed.
func (b StreamBar) Show(c *Context, r geom.Rect) BarAction {
	c.Paint.Fill(r, 0, theme.WithAlpha(c.Theme.Tint, barPlate))
	action := BarNone
	size := float32(barIcon + 2*barPadX)
	height := float32(barIcon + 2*barPadY)
	top := r.Y + (r.H-height)/2
	button := func(x float32, icon string, enabled bool, on BarAction) {
		box := geom.Rect{X: x, Y: top, W: size, H: height}
		hovered := enabled && c.Hovered(box)
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			c.Paint.Fill(box, barBtnRadius, theme.WithAlpha(c.Theme.Tint, barPlateHover))
			if c.In.Pressed {
				c.Claim()
				action = on
			}
		}
		ink := c.Theme.Text
		if !enabled {
			ink = theme.WithAlpha(ink, barDimmed)
		}
		c.Paint.Icon(icon, geom.Rect{X: box.X + (box.W-barIcon)/2, Y: box.Y + (box.H-barIcon)/2, W: barIcon, H: barIcon}, ink)
	}

	x := r.X + barPadX + b.Left
	many := b.Total > 1
	button(x, "caret-left", many, BarPrev)
	x += size + barGap
	count := strconv.Itoa(b.Index+1) + "/" + strconv.Itoa(b.Total)
	line := float32(barCountStyle.Size * 1.5)
	c.Paint.Text(count, x, r.Y+(r.H-line)/2, line, barCountStyle, theme.WithAlpha(c.Theme.Text, barCountAlpha))
	x += c.Paint.TextWidth(count, barCountStyle) + barGap
	button(x, "caret-right", many, BarNext)
	x += size + barGap

	right := r.Right() - barPadX
	for _, btn := range [...]struct {
		icon string
		on   BarAction
	}{{"x", BarClose}, {"squares-four", BarStage}, {b.PopIcon, BarPop}} {
		if btn.icon == "" {
			continue
		}
		right -= size
		button(right, btn.icon, true, btn.on)
		right -= barGap
	}
	if b.Note != "" && right-x > 0 {
		clip := geom.Rect{X: x, Y: r.Y, W: right - x, H: r.H}
		width := c.Paint.TextWidth(b.Note, barNoteStyle)
		c.Paint.TextIn(clip, b.Note, max(x, right-width), r.Y+(r.H-line)/2, line, barNoteStyle, c.Theme.Accent)
	}
	if action == BarNone && c.Hovered(r) && c.In.Pressed && !c.Claimed() {
		c.Claim()
		action = BarGrab
	}
	return action
}
