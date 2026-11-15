package settings

import (
	"image/color"

	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	customCell     = 144
	customGap      = 8
	customPadX     = 8
	customPadY     = 5.6
	customRadius   = 8
	customNameSize = 12.8
	customNameGap  = 8
	customTop      = 9.6
)

// customName is the swatch's label, which Electron writes in English whatever the language.
const customName = "Custom"

// customEditor is the four pickers that make a custom palette, shown while it is the palette in use.
type customEditor struct {
	d       *Dialog
	pickers [4]widget.ColorPicker
}

func newCustomEditor(d *Dialog) *customEditor {
	e := &customEditor{d: d}
	for i := range e.pickers {
		e.pickers[i].OnChange = func(hex string) { e.change(i, hex) }
	}
	return e
}

func (e *customEditor) colours() *store.CustomColours {
	if e.d.Settings.CustomTheme == nil {
		from := theme.ByName(e.d.Settings.Theme).Colours()
		e.d.Settings.CustomTheme = &store.CustomColours{Bg: from.Bg, Surface: from.Surface, Text: from.Text, Accent: from.Accent}
	}
	return e.d.Settings.CustomTheme
}

func (e *customEditor) field(i int) *string {
	c := e.colours()
	return [...]*string{&c.Bg, &c.Surface, &c.Text, &c.Accent}[i]
}

func (e *customEditor) change(i int, hex string) {
	*e.field(i) = hex
	e.d.apply()
}

// choose makes the custom palette the one in use, starting from the palette that was, the first time.
func (e *customEditor) choose() {
	e.colours()
	e.d.Settings.Theme = theme.CustomName
	e.d.apply()
}

func (e *customEditor) startAgain() {
	from := theme.ByName(theme.Default).Colours()
	*e.d.Settings.CustomTheme = store.CustomColours{Bg: from.Bg, Surface: from.Surface, Text: from.Text, Accent: from.Accent}
	e.d.Settings.Theme = theme.CustomName
	e.d.apply()
}

func (e *customEditor) bands() [3]color.RGBA {
	if e.d.Settings.CustomTheme == nil {
		return [3]color.RGBA{{0x44, 0x44, 0x44, 255}, {0x66, 0x66, 0x66, 255}, {0x88, 0x88, 0x88, 255}}
	}
	p := theme.Custom(theme.Colours(*e.d.Settings.CustomTheme))
	return [3]color.RGBA{p.Bg, p.Surface, p.Accent}
}

func (e *customEditor) swatch(c *widget.Context) widget.Swatch {
	return widget.Swatch{Label: customName, Bands: e.bands(), On: e.d.Settings.Theme == theme.CustomName, OnClick: e.choose}
}

// editor is the pickers with the way back, or nothing while another palette is in use.
func (e *customEditor) editor(c *widget.Context) widget.Component {
	if e.d.Settings.Theme != theme.CustomName {
		return widget.Spacer{}
	}
	names := [4]string{c.T("theme.background"), c.T("theme.panels"), c.T("theme.text"), c.T("theme.accent")}
	grid := &widget.Grid{MinCell: customCell, Gap: customGap}
	for i := range e.pickers {
		e.pickers[i].Value = *e.field(i)
		grid.Children = append(grid.Children, colourField{name: names[i], picker: &e.pickers[i]})
	}
	reset := &widget.Button{Label: c.T("app.start_again_from_midnight"), Variant: widget.Ghost, Small: true, OnClick: e.startAgain}
	return widget.Padded{Top: customTop, Child: widget.Col(customGap, grid, widget.Start{Child: reset})}
}

var customNameStyle = paint.TextStyle{Size: customNameSize, Weight: paint.Regular}

// colourField is one colour: its picker and its name, in a box.
type colourField struct {
	name   string
	picker *widget.ColorPicker
}

func (f colourField) Measure(c *widget.Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: f.picker.Measure(c, 0).H + 2*(customPadY+c.Hairline())}
}

func (f colourField) Draw(c *widget.Context, r geom.Rect) {
	c.Paint.Fill(r, customRadius, c.Theme.Surface)
	c.Paint.Stroke(r, customRadius, c.Hairline(), c.Theme.Border)
	well := f.picker.Measure(c, 0)
	inner := r.InsetAll(c.Hairline())
	f.picker.Draw(c, geom.Rect{X: inner.X + customPadX, Y: inner.Y + (inner.H-well.H)/2, W: well.W, H: well.H})
	line := float32(customNameSize * 1.5)
	c.Paint.Text(f.name, inner.X+customPadX+well.W+customNameGap, inner.Y+(inner.H-line)/2, line, customNameStyle, c.Theme.Text)
}
