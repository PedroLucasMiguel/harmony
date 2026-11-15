package sharepicker

import (
	"image/color"

	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video/native"
)

var backdrop = color.RGBA{A: 153}

// cardGrid lays the source cards out in as many columns of at least gridMinCol as fit, as the Electron picker's CSS grid does.
type cardGrid struct{ cards []widget.SourceCard }

func (g cardGrid) columns(width float32) int {
	return max(1, int((width+gridGap)/(gridMinCol+gridGap)))
}

func (g cardGrid) Measure(c *widget.Context, maxWidth float32) geom.Size {
	cols := g.columns(maxWidth)
	colW := (maxWidth - float32(cols-1)*gridGap) / float32(cols)
	var h float32
	for i := range g.cards {
		if i%cols == 0 {
			if i > 0 {
				h += gridGap
			}
			h += g.cards[i].Measure(c, colW).H
		}
	}
	return geom.Size{W: maxWidth, H: h}
}

func (g cardGrid) Draw(c *widget.Context, r geom.Rect) {
	cols := g.columns(r.W)
	colW := (r.W - float32(cols-1)*gridGap) / float32(cols)
	y := r.Y
	for i := 0; i < len(g.cards); i += cols {
		rowH := g.cards[i].Measure(c, colW).H
		for j := i; j < min(i+cols, len(g.cards)); j++ {
			g.cards[j].Draw(c, geom.Rect{X: r.X + float32(j-i)*(colW+gridGap), Y: y, W: colW, H: rowH})
		}
		y += rowH + gridGap
	}
}

func (d *Dialog) drawGrid(c *widget.Context, r geom.Rect, items []native.SourceInfo, loading bool) {
	if len(items) == 0 {
		text := c.T("picker.none_" + string(d.kind))
		if d.kind == native.KindCamera {
			text = c.T("picker.none_cameras")
		}
		if loading {
			text = c.T("picker.loading")
		}
		style := paint.TextStyle{Size: 14, Weight: paint.Regular}
		tw := c.Paint.TextWidth(text, style)
		c.Paint.Text(text, r.X+(r.W-tw)/2, r.Y+(r.H-21)/2, 21, style, c.Theme.Muted)
		return
	}
	d.cards = d.cards[:0]
	for _, s := range items {
		s := s
		card := widget.SourceCard{Name: s.Name, Detail: detail(s), Selected: s.ID == d.selected, NoThumb: s.Kind == native.KindCamera, OnClick: func() { d.selected = s.ID }}
		if s.Kind != native.KindCamera {
			t := d.catalog.thumbFor(s.ID)
			t.surface.Update(t)
			card.Thumb = &t.surface
		}
		d.cards = append(d.cards, card)
	}
	d.grid.Bar = true
	d.grid.Child = cardGrid{cards: d.cards}
	inset := geom.Rect{X: r.X + gridPad, Y: r.Y + gridPad, W: r.W - 2*gridPad, H: r.H - 2*gridPad}
	d.grid.Draw(c, inset)
}

const permBorderAlpha = 0.45
const permFillAlpha = 0.08

func (d *Dialog) permHeight(c *widget.Context, width float32) float32 {
	body := &widget.Text{Content: c.T("screen_permission.body"), Style: permBody, LineHeight: permBody.Size * 1.5, Tone: widget.ToneText, Wrap: true}
	title := permBody.Size * 1.5
	return 2*permPadding + title + 6 + body.Measure(c, width-2*permPadding).H + 11 + d.open.Measure(c, 0).H + permMargin
}

func (d *Dialog) drawPermission(c *widget.Context, r geom.Rect) {
	box := geom.Rect{X: r.X, Y: r.Y, W: r.W, H: r.H - permMargin}
	c.Paint.Fill(box, 8, theme.WithAlpha(c.Theme.Danger, permFillAlpha))
	c.Paint.Stroke(box, 8, c.Hairline(), theme.WithAlpha(c.Theme.Danger, permBorderAlpha))
	in := box.InsetAll(permPadding)
	title := permBody
	title.Weight = paint.Bold
	c.Paint.Text(c.T("screen_permission.title"), in.X, in.Y, permBody.Size*1.5, title, c.Theme.Text)
	y := in.Y + permBody.Size*1.5 + 6
	body := &widget.Text{Content: c.T("screen_permission.body"), Style: permBody, LineHeight: permBody.Size * 1.5, Tone: widget.ToneText, Wrap: true}
	bh := body.Measure(c, in.W).H
	body.Draw(c, geom.Rect{X: in.X, Y: y, W: in.W, H: bh})
	size := d.open.Measure(c, 0)
	d.open.Draw(c, geom.Rect{X: in.X, Y: y + bh + 11, W: size.W, H: size.H})
}
