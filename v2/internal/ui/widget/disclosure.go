package widget

import (
	"image/color"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
)

const (
	disclosurePaddingTop = 14
	disclosureBodyGap    = 14
	disclosureMarkerGap  = 8
	disclosureMarkerW    = 5.9
	disclosureLabelSize  = 12
	disclosureMarkerDrop = 0.7
)

type Disclosure struct {
	Summary string
	Open    bool
	Body    Component
}

func (d *Disclosure) summary() *Text {
	return &Text{
		Content: d.Summary, Upper: true,
		Style:      paint.TextStyle{Size: disclosureLabelSize, Weight: paint.Semibold, Spacing: fieldLabelSpacing},
		LineHeight: disclosureLabelSize * 1.5,
	}
}

func (d *Disclosure) head(c *Context) float32 {
	return c.Hairline() + disclosurePaddingTop + disclosureLabelSize*1.5
}

func (d *Disclosure) Measure(c *Context, maxWidth float32) geom.Size {
	height := d.head(c)
	if d.Open {
		height += disclosureBodyGap + d.Body.Measure(c, maxWidth).H
	}
	return geom.Size{W: maxWidth, H: height}
}

func (d *Disclosure) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Y, W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
	row := geom.Rect{X: r.X, Y: r.Y + c.Hairline() + disclosurePaddingTop, W: r.W, H: disclosureLabelSize * 1.5}
	hovered := c.Hovered(row)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if c.Clicked(row) {
		c.Claim()
		d.Open = !d.Open
	}
	tone := ToneMuted
	if hovered {
		tone = ToneText
	}
	ink := tone.Color(c.Theme)
	d.drawMarker(c, row, ink)
	label := d.summary()
	label.Tone = tone
	label.Draw(c, geom.Rect{X: row.X + disclosureMarkerW + disclosureMarkerGap, Y: row.Y, W: row.W, H: row.H})
	if d.Open {
		top := row.Bottom() + disclosureBodyGap
		d.Body.Draw(c, geom.Rect{X: r.X, Y: top, W: r.W, H: r.Bottom() - top})
	}
}

func (d *Disclosure) drawMarker(c *Context, row geom.Rect, ink color.RGBA) {
	cx, cy := row.X+disclosureMarkerW/2, row.Y+row.H/2+disclosureMarkerDrop
	if d.Open {
		c.Paint.Triangle([2]float32{cx - 2, cy - 1.75}, [2]float32{cx - 0.05, cy + 1.75}, [2]float32{cx + 1.9, cy - 1.75}, ink)
		return
	}
	c.Paint.Triangle([2]float32{cx - 2, cy - 1.75}, [2]float32{cx - 2, cy + 1.75}, [2]float32{cx + 1.9, cy}, ink)
}
