package widget

import (
	"strconv"
	"time"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/i18n"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
)

const (
	styleMinStops   = 2
	styleMaxStops   = 4
	styleMinSeconds = 1
	styleMaxSeconds = 30
	styleSpeedSteps = 2
	styleDefaultSec = 6
	styleSoloColor  = "#8e2de2"
	styleSecondStop = "#00c6ff"

	styleGap          = 9.6
	stylePreviewPadY  = 8
	stylePreviewPadX  = 12.8
	stylePreviewSize  = 16.8
	styleTileGap      = 8
	styleTileHeight   = 44.8
	styleTileSize     = 13.6
	styleTileBelow    = 10
	styleRowGapX      = 16
	styleStopGap      = 8
	styleHexWidth     = 176
	styleHexGap       = 3.2
	styleSpeedGap     = 9.6
	styleTileEdge     = 0.14
	styleTileFill     = 0.04
	styleTileHover    = 0.09
	styleTileOn       = 0.16
	styleDash         = 3
	styleDisabledTone = 0.45
)

// NameStyleValue is how a name is coloured while it is being edited: Mode is "solid", "gradient" or "rainbow". Color is the
// plain colour as typed, which may be half a hex code; Colors are the stops of a gradient.
type NameStyleValue struct {
	Mode   string
	Color  string
	Colors []string
	Speed  float64
}

// Valid is whether every colour in use is a whole hex code.
func (v NameStyleValue) Valid() bool {
	switch v.Mode {
	case "gradient":
		for _, c := range v.Colors {
			if _, ok := people.ParseColor(c); !ok {
				return false
			}
		}
		return len(v.Colors) >= styleMinStops
	case "rainbow":
		return true
	}
	_, ok := people.ParseColor(v.Color)
	return ok
}

// NameStyleEditor edits the look of a name: a plain colour, a gradient that moves, or the rainbow, with a preview drawn as it
// will be. The caller owns Value; every change the person makes lands in it and is reported with how soon it should be sent.
type NameStyleEditor struct {
	Sample   string
	Value    NameStyleValue
	Disabled bool
	// Bare leaves out the preview and the three tiles, for a screen that has its own: only the colours and the speed remain.
	Bare       bool
	SpeedWidth float32
	// Labels are the texts in the person's language: solid, gradient, rainbow, add a colour, speed.
	Labels struct{ Solid, Gradient, Rainbow, Add, Speed string }
	// OnChange is called after Value changed, with how soon the change should be sent: sooner for a click than for a drag.
	OnChange func(delay time.Duration)

	well    ColorPicker
	hex     TextField
	stops   [styleMaxStops]ColorPicker
	remove  [styleMaxStops]GlyphButton
	add     Button
	slider  Slider
	hexSeen string
	shown   [4]people.Style
	dirty   bool

	speedText string
	speedSeen float64
	speedLang *i18n.Bundle
}

// Set takes a value from outside, as when another role is selected or the server says something new.
func (e *NameStyleEditor) Set(v NameStyleValue) {
	e.Value = NameStyleValue{Mode: v.Mode, Color: v.Color, Colors: append([]string(nil), v.Colors...), Speed: v.Speed}
	if e.Value.Mode == "" {
		e.Value.Mode = "solid"
	}
	e.hex.Value, e.hexSeen, e.dirty = e.Value.Color, e.Value.Color, true
}

func (e *NameStyleEditor) speed() float64 {
	if e.Value.Speed <= 0 {
		return styleDefaultSec
	}
	return e.Value.Speed
}

func (e *NameStyleEditor) changed(delay time.Duration) {
	e.dirty = true
	if e.OnChange != nil {
		e.OnChange(delay)
	}
}

// Choose makes the look a solid colour, a gradient or the rainbow, as its tile does.
func (e *NameStyleEditor) Choose(mode string) {
	if mode == e.Value.Mode {
		return
	}
	v := &e.Value
	switch mode {
	case "solid":
		if v.Mode == "gradient" && len(v.Colors) > 0 {
			v.Color = v.Colors[0]
		}
		v.Colors = nil
		e.hex.Value, e.hexSeen = v.Color, v.Color
	default:
		if v.Mode == "solid" {
			first := styleSoloColor
			if _, ok := people.ParseColor(v.Color); ok {
				first = v.Color
			}
			v.Colors = []string{first, styleSecondStop}
		}
		if mode == "rainbow" {
			v.Colors = nil
		} else if len(v.Colors) < styleMinStops {
			v.Colors = []string{styleSoloColor, styleSecondStop}
		}
		if mode == "gradient" {
			v.Color = v.Colors[0]
		}
		v.Speed = e.speed()
	}
	v.Mode = mode
	e.changed(150 * time.Millisecond)
}

func (e *NameStyleEditor) refresh() {
	if !e.dirty {
		return
	}
	e.dirty = false
	v := e.Value
	e.shown[0] = people.StyleFor(v.Mode, v.Color, v.Colors, v.Speed)
	e.shown[1] = people.StyleFor("solid", v.Color, nil, 0)
	grad := v.Colors
	if v.Mode != "gradient" || len(grad) < styleMinStops {
		first := styleSoloColor
		if _, ok := people.ParseColor(v.Color); ok && v.Mode == "solid" {
			first = v.Color
		}
		grad = []string{first, styleSecondStop}
	}
	e.shown[2] = people.StyleFor("gradient", "", grad, e.speed())
	e.shown[3] = people.StyleFor("rainbow", "", nil, e.speed())
}

var (
	stylePreviewStyle = paint.TextStyle{Size: stylePreviewSize, Weight: paint.Bold}
	styleTileStyle    = paint.TextStyle{Size: styleTileSize, Weight: paint.Regular}
)

func (e *NameStyleEditor) previewHeight() float32 {
	return 2*stylePreviewPadY + stylePreviewSize*1.5 + 2
}

func (e *NameStyleEditor) stopCount() int {
	if e.Value.Mode == "gradient" {
		return len(e.Value.Colors)
	}
	return 0
}

func (e *NameStyleEditor) rowHeight(c *Context) float32 {
	e.hex.Inset = true
	return max(colorWellH, e.hex.Measure(c, 0).H)
}

func (e *NameStyleEditor) hasStops() bool {
	return e.Value.Mode == "solid" || e.Value.Mode == "gradient"
}

func (e *NameStyleEditor) hasSpeed() bool {
	return e.Value.Mode == "gradient" || e.Value.Mode == "rainbow"
}

func (e *NameStyleEditor) Measure(c *Context, maxWidth float32) geom.Size {
	h := float32(0)
	if !e.Bare {
		h = e.previewHeight() + styleGap + styleTileHeight + styleTileBelow + styleGap
	}
	if e.hasStops() {
		h += e.rowHeight(c)
		if e.hasSpeed() {
			h += styleGap
		}
	}
	if e.hasSpeed() {
		h += e.speedHeight(c, maxWidth)
	}
	if !e.Bare && !e.hasStops() && !e.hasSpeed() {
		h -= styleGap
	}
	return geom.Size{W: maxWidth, H: h}
}

func (e *NameStyleEditor) Draw(c *Context, r geom.Rect) {
	e.refresh()
	y := r.Y
	if !e.Bare {
		preview := geom.Rect{X: r.X, Y: y, W: r.W, H: e.previewHeight()}
		c.Paint.DashedRoundRect(preview, 8, c.Hairline(), styleDash, styleDash, c.Theme.Border)
		c.DrawName(e.Sample, &e.shown[0], preview.X+stylePreviewPadX, preview.Y+stylePreviewPadY+1, stylePreviewSize*1.5, stylePreviewStyle, c.Theme.Text)
		y = preview.Bottom() + styleGap
		e.drawTiles(c, geom.Rect{X: r.X, Y: y, W: r.W, H: styleTileHeight})
		y += styleTileHeight + styleTileBelow + styleGap
	}
	if e.hasStops() {
		rowH := e.rowHeight(c)
		e.drawStops(c, geom.Rect{X: r.X, Y: y, W: r.W, H: rowH})
		y += rowH
		if e.hasSpeed() {
			y += styleGap
		}
	}
	if e.hasSpeed() {
		e.drawSpeed(c, geom.Rect{X: r.X, Y: y, W: r.W, H: e.speedHeight(c, r.W)})
	}
}

func (e *NameStyleEditor) drawTiles(c *Context, r geom.Rect) {
	modes := [3]string{"solid", "gradient", "rainbow"}
	labels := [3]string{e.Labels.Solid, e.Labels.Gradient, e.Labels.Rainbow}
	width := (r.W - 2*styleTileGap) / 3
	for i, mode := range modes {
		cell := geom.Rect{X: r.X + float32(i)*(width+styleTileGap), Y: r.Y, W: width, H: r.H}
		on := mode == e.Value.Mode
		hovered := !e.Disabled && c.Hovered(cell)
		fill, edge := theme.WithAlpha(c.Theme.Tint, styleTileFill), theme.WithAlpha(c.Theme.Tint, styleTileEdge)
		switch {
		case on:
			fill, edge = theme.WithAlpha(c.Theme.Accent, styleTileOn), c.Theme.Accent
		case hovered:
			fill = theme.WithAlpha(c.Theme.Tint, styleTileHover)
		}
		c.Paint.Fill(cell, 8, fill)
		c.Paint.Stroke(cell, 8, c.Hairline(), edge)
		look := &e.shown[1+i]
		base := c.Theme.Text
		if e.Disabled {
			base = theme.WithAlpha(base, styleDisabledTone)
		}
		w := c.NameWidth(labels[i], look, styleTileStyle)
		c.DrawName(labels[i], look, cell.X+(cell.W-w)/2, cell.Y+(cell.H-styleTileSize*1.5)/2-1, styleTileSize*1.5, styleTileStyle, base)
		if hovered {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.In.Pressed {
				c.Claim()
				e.Choose(mode)
			}
		}
	}
}

func (e *NameStyleEditor) drawStops(c *Context, r geom.Rect) {
	switch e.Value.Mode {
	case "solid":
		e.drawSolid(c, r)
	case "gradient":
		e.drawGradient(c, r)
	}
}

func (e *NameStyleEditor) drawSolid(c *Context, r geom.Rect) {
	e.well.Value, e.well.Disabled = e.Value.Color, e.Disabled
	e.well.OnChange = e.pickSolid
	e.well.Draw(c, geom.Rect{X: r.X, Y: r.Y + (r.H-colorWellH)/2, W: colorWellW, H: colorWellH})
	hexRect := geom.Rect{X: r.X + colorWellW + styleHexGap, Y: r.Y, W: styleHexWidth, H: r.H}
	e.hex.MaxLength, e.hex.Inset = 7, true
	_, ok := people.ParseColor(e.Value.Color)
	e.hex.Invalid = !ok && e.Value.Color != ""
	if e.Disabled {
		c.Paint.Fill(hexRect, insetRadius, c.Theme.Bg)
		c.Paint.Stroke(hexRect, insetRadius, c.Hairline(), theme.WithAlpha(c.Theme.Tint, insetEdgeAlpha))
		c.Paint.Text(e.Value.Color, hexRect.X+insetPadX, hexRect.Y+insetPadY, fieldLineHeight, fieldStyle, theme.WithAlpha(c.Theme.Text, styleDisabledTone))
		return
	}
	if e.hexSeen != e.Value.Color {
		e.hex.Value, e.hexSeen = e.Value.Color, e.Value.Color
	}
	e.hex.Draw(c, hexRect)
	if e.hex.Value != e.hexSeen {
		e.hexSeen, e.Value.Color = e.hex.Value, e.hex.Value
		e.changed(600 * time.Millisecond)
	}
}

func (e *NameStyleEditor) pickSolid(hex string) {
	e.Value.Color = hex
	e.changed(500 * time.Millisecond)
}

func (e *NameStyleEditor) drawGradient(c *Context, r geom.Rect) {
	x, y := r.X, r.Y
	n := len(e.Value.Colors)
	for i := range n {
		w := float32(colorWellW)
		removable := n > styleMinStops
		if removable {
			w += styleHexGap + glyphIcon + 2*glyphPadX
		}
		if x > r.X && x+w > r.Right() {
			x, y = r.X, y+colorWellH+styleGap
		}
		stop := &e.stops[i]
		stop.Value, stop.Disabled = e.Value.Colors[i], e.Disabled
		index := i
		stop.OnChange = func(hex string) { e.pickStop(index, hex) }
		stop.Draw(c, geom.Rect{X: x, Y: y, W: colorWellW, H: colorWellH})
		if removable {
			btn := &e.remove[i]
			btn.Icon, btn.Disabled = "x", e.Disabled
			btn.OnClick = func() { e.removeStop(index) }
			size := btn.Measure(c, 0)
			btn.Draw(c, geom.Rect{X: x + colorWellW + styleHexGap, Y: y + (colorWellH-size.H)/2, W: size.W, H: size.H})
		}
		x += w + styleStopGap
	}
	if n < styleMaxStops {
		e.add.Label, e.add.Variant, e.add.Small, e.add.Disabled = e.Labels.Add, Ghost, true, e.Disabled
		e.add.OnClick = e.addStop
		size := e.add.Measure(c, 0)
		if x > r.X && x-styleStopGap+styleRowGapX+size.W > r.Right() {
			x, y = r.X, y+colorWellH+styleGap
		} else if x > r.X {
			x += styleRowGapX - styleStopGap
		}
		e.add.Draw(c, geom.Rect{X: x, Y: y + (colorWellH-size.H)/2, W: size.W, H: size.H})
	}
}

func (e *NameStyleEditor) pickStop(i int, hex string) {
	if i >= len(e.Value.Colors) {
		return
	}
	e.Value.Colors[i] = hex
	if i == 0 {
		e.Value.Color = hex
	}
	e.changed(500 * time.Millisecond)
}

func (e *NameStyleEditor) removeStop(i int) {
	if i >= len(e.Value.Colors) || len(e.Value.Colors) <= styleMinStops {
		return
	}
	e.Value.Colors = append(e.Value.Colors[:i], e.Value.Colors[i+1:]...)
	e.Value.Color = e.Value.Colors[0]
	e.changed(150 * time.Millisecond)
}

func (e *NameStyleEditor) addStop() {
	if len(e.Value.Colors) >= styleMaxStops {
		return
	}
	e.Value.Colors = append(e.Value.Colors, e.Value.Colors[len(e.Value.Colors)-1])
	e.changed(150 * time.Millisecond)
}

var speedStyle = paint.TextStyle{Size: 14, Weight: paint.Regular}

const speedLine = 21

func (e *NameStyleEditor) speedWidth() float32 {
	if e.SpeedWidth == 0 {
		return 112
	}
	return e.SpeedWidth
}

func (e *NameStyleEditor) speedValue(c *Context) string {
	if e.speedText == "" || e.speedSeen != e.speed() || e.speedLang != c.Strings {
		e.speedSeen, e.speedLang = e.speed(), c.Strings
		e.speedText = c.T("profile.color_speed_value", "seconds", strconv.FormatFloat(e.speed(), 'f', -1, 64))
	}
	return e.speedText
}

// speedWraps is whether the value no longer fits beside the slider and goes on a line of its own.
func (e *NameStyleEditor) speedWraps(c *Context, width float32) bool {
	need := c.Paint.TextWidth(e.Labels.Speed, speedStyle) + styleSpeedGap + e.speedWidth() + styleSpeedGap + c.Paint.TextWidth(e.speedValue(c), speedStyle)
	return need > width
}

func (e *NameStyleEditor) speedHeight(c *Context, width float32) float32 {
	if e.speedWraps(c, width) {
		return 2*speedLine + styleSpeedGap
	}
	return speedLine
}

// The slider counts half seconds, backwards: the faster, the further right.
func (e *NameStyleEditor) drawSpeed(c *Context, r geom.Rect) {
	caption := e.Labels.Speed
	captionW := c.Paint.TextWidth(caption, speedStyle)
	c.Paint.Text(caption, r.X, r.Y, speedLine, speedStyle, c.Theme.Text)

	e.slider.Min, e.slider.Max, e.slider.Step = styleMinSeconds*styleSpeedSteps, styleMaxSeconds*styleSpeedSteps, 1
	e.slider.Value = int((styleMaxSeconds+styleMinSeconds-e.speed())*styleSpeedSteps + 0.5)
	e.slider.OnChange = e.setSpeed
	width := e.speedWidth()
	x := r.X + captionW + styleSpeedGap
	e.slider.Draw(c, geom.Rect{X: x, Y: r.Y + (speedLine-sliderBox)/2, W: width, H: sliderBox})
	value, valueX, valueY := e.speedValue(c), x+width+styleSpeedGap, r.Y
	if e.speedWraps(c, r.W) {
		valueX, valueY = r.X, r.Y+speedLine+styleSpeedGap
	}
	c.Paint.Text(value, valueX, valueY, speedLine, speedStyle, c.Theme.Text)
}

func (e *NameStyleEditor) setSpeed(v int) {
	e.Value.Speed = styleMaxSeconds + styleMinSeconds - float64(v)/styleSpeedSteps
	e.changed(500 * time.Millisecond)
}
