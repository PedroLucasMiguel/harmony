package widget

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	filterChipFont     = 12.8
	filterChipPadY     = 1.6
	filterChipPadLeft  = 8
	filterChipPadRight = 3.2
	filterChipGap      = 4.8
	filterChipRadius   = 6
	filterChipFill     = 0.12
	filterChipKeyAlpha = 0.7
	filterChipCross    = 17.6
	filterChipCrossIcn = 8
	filterChipCrossA   = 0.6
	filterChipCrossHov = 0.15
)

var (
	filterChipKeyStyle   = paint.TextStyle{Size: filterChipFont, Weight: paint.Semibold}
	filterChipValueStyle = paint.TextStyle{Size: filterChipFont, Weight: paint.Regular}
)

// FilterChip is a filter chosen in a search: its name and its value, and a cross that takes it away (Static has no cross).
type FilterChip struct {
	Key, Value string
	Static     bool
}

func (ch FilterChip) Measure(c *Context) geom.Size {
	w := filterChipPadLeft + c.Paint.TextWidth(ch.Key, filterChipKeyStyle) + filterChipGap + c.Paint.TextWidth(ch.Value, filterChipValueStyle)
	if ch.Static {
		w += filterChipPadLeft
	} else {
		w += filterChipGap + filterChipCross + filterChipPadRight
	}
	return geom.Size{W: w, H: filterChipFont*1.5 + 2*filterChipPadY}
}

// Show draws the chip and says whether its cross was pressed.
func (ch FilterChip) Show(c *Context, r geom.Rect) (removed bool) {
	c.Paint.Fill(r, filterChipRadius, theme.WithAlpha(c.Theme.Tint, filterChipFill))
	line := float32(filterChipFont * 1.5)
	top := r.Y + (r.H-line)/2
	x := r.X + filterChipPadLeft
	c.Paint.Text(ch.Key, x, top, line, filterChipKeyStyle, theme.WithAlpha(c.Theme.Text, filterChipKeyAlpha))
	x += c.Paint.TextWidth(ch.Key, filterChipKeyStyle) + filterChipGap
	c.Paint.Text(ch.Value, x, top, line, filterChipValueStyle, c.Theme.Text)
	if ch.Static {
		return false
	}
	x += c.Paint.TextWidth(ch.Value, filterChipValueStyle) + filterChipGap
	cross := geom.Rect{X: x, Y: r.Y + (r.H-filterChipCross)/2, W: filterChipCross, H: filterChipCross}
	alpha := float32(filterChipCrossA)
	if c.Hovered(cross) {
		alpha = 1
		c.SetCursor(rl.MouseCursorPointingHand)
		c.Paint.Fill(cross, 4, theme.WithAlpha(c.Theme.Tint, filterChipCrossHov))
	}
	c.Paint.Icon("x", geom.Rect{X: cross.X + (filterChipCross-filterChipCrossIcn)/2, Y: cross.Y + (filterChipCross-filterChipCrossIcn)/2, W: filterChipCrossIcn, H: filterChipCrossIcn}, theme.WithAlpha(c.Theme.Text, alpha))
	if c.Clicked(cross) {
		c.Claim()
		return true
	}
	return false
}
