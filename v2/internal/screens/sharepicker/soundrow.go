package sharepicker

import (
	"strings"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

// SoundRow is a row for the picker's Extra hook: a label over a drop-down or a segmented choice, laid out like the rows
// the picker draws itself.
type SoundRow struct {
	Label     string
	Dropdown  *widget.Dropdown
	Segmented *widget.Segmented
}

func (r SoundRow) control() widget.Component {
	if r.Dropdown != nil {
		return r.Dropdown
	}
	return r.Segmented
}

func (r SoundRow) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: labelSize*1.5 + labelGap + r.control().Measure(c, maxWidth).H}
}

func (r SoundRow) Draw(c *widget.Context, at geom.Rect) {
	c.Paint.Text(strings.ToUpper(r.Label), at.X, at.Y, labelSize*1.5, paint.TextStyle{Size: labelSize, Weight: paint.Bold, Spacing: 0.04 * labelSize}, c.Theme.Muted)
	y := at.Y + labelSize*1.5 + labelGap
	r.control().Draw(c, geom.Rect{X: at.X, Y: y, W: at.W, H: at.Bottom() - y})
}
