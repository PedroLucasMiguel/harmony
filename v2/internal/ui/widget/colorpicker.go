package widget

import (
	"image/color"
	"math"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/theme"
)

const (
	colorWellW        = 36.5
	colorWellH        = 32
	colorWellRadius   = 6
	colorSwatchW      = 17
	colorSwatchH      = 11
	colorSwatchRadius = 2
	colorAreaW        = 208
	colorAreaH        = 128
	colorBarH         = 14
	colorPanelGap     = 8
	colorKnob         = 6
)

// ColorPicker is a small well that shows a colour and opens a panel to choose another: a square for saturation and
// brightness, a bar for the hue, and the hex code. OnChange follows the choice as it is made.
type ColorPicker struct {
	Value    string
	Disabled bool
	OnChange func(hex string)

	pop       Popover
	hex       TextField
	hue, s, v float32
	area, bar bool
	loaded    string
	typed     string
	paint     func(content geom.Rect)
	c         *Context
}

func (k *ColorPicker) Measure(*Context, float32) geom.Size {
	return geom.Size{W: colorWellW, H: colorWellH}
}

func (k *ColorPicker) Draw(c *Context, r geom.Rect) {
	k.c = c
	hovered := !k.Disabled && c.Hovered(r)
	if hovered {
		c.SetCursor(rl.MouseCursorPointingHand)
		if c.In.Pressed {
			c.Claim()
			k.pop.Toggle()
			if k.pop.IsOpen() {
				k.load(k.Value)
			}
		}
	}
	edge := c.Theme.Border
	if hovered || k.pop.IsOpen() {
		edge = c.Theme.BorderStrong
	}
	c.Paint.Stroke(r, colorWellRadius, c.Hairline(), edge)
	if shown, ok := people.ParseColor(k.Value); ok {
		c.Paint.Fill(geom.Rect{X: r.X + (r.W-colorSwatchW)/2, Y: r.Y + (r.H-colorSwatchH)/2, W: colorSwatchW, H: colorSwatchH}, colorSwatchRadius, shown)
	}
	if k.Disabled {
		k.pop.Close()
	}
	if k.paint == nil {
		k.paint = k.drawPanel
	}
	k.pop.Roomy = true
	k.pop.Draw(c, r, r, geom.Size{W: colorAreaW, H: colorAreaH + 2*colorPanelGap + colorBarH + k.fieldHeight(c)}, k.paint)
}

// load takes the hue, saturation and brightness from a hex colour, if it is one.
func (k *ColorPicker) load(hex string) {
	if rgb, ok := people.ParseColor(hex); ok {
		k.hue, k.s, k.v = rgbToHSV(rgb)
	}
	k.loaded, k.hex.Value, k.typed = hex, hex, hex
}

func (k *ColorPicker) emit() {
	hex := hexOf(hsvToRGB(k.hue, k.s, k.v))
	k.loaded, k.hex.Value, k.typed = hex, hex, hex
	if k.OnChange != nil {
		k.OnChange(hex)
	}
}

func (k *ColorPicker) drawPanel(content geom.Rect) {
	c := k.c
	area := geom.Rect{X: content.X, Y: content.Y, W: content.W, H: colorAreaH}
	bar := geom.Rect{X: content.X, Y: area.Bottom() + colorPanelGap, W: content.W, H: colorBarH}
	field := geom.Rect{X: content.X, Y: bar.Bottom() + colorPanelGap, W: content.W, H: k.fieldHeight(c)}

	k.dragArea(c, area)
	k.dragBar(c, bar)

	pure := hsvToRGB(k.hue, 1, 1)
	white, clear, black := color.RGBA{255, 255, 255, 255}, color.RGBA{A: 0}, color.RGBA{A: 255}
	c.Paint.PushClip(area)
	c.Paint.Quad4(area, white, pure, pure, white)
	c.Paint.Quad4(area, clear, clear, black, black)
	c.Paint.PopClip()
	c.Paint.Stroke(area, 0, c.Hairline(), theme.WithAlpha(c.Theme.Tint, 0.2))
	kx, ky := area.X+k.s*area.W, area.Y+(1-k.v)*area.H
	c.Paint.Circle(kx, ky, colorKnob, white)
	c.Paint.Circle(kx, ky, colorKnob-1.6, hsvToRGB(k.hue, k.s, k.v))

	stops := [7]color.RGBA{}
	for i := range stops {
		stops[i] = hsvToRGB(float32(i)/6, 1, 1)
	}
	step := bar.W / 6
	for i := 0; i < 6; i++ {
		c.Paint.Quad4(geom.Rect{X: bar.X + float32(i)*step, Y: bar.Y, W: step, H: bar.H}, stops[i], stops[i+1], stops[i+1], stops[i])
	}
	c.Paint.Stroke(bar, 0, c.Hairline(), theme.WithAlpha(c.Theme.Tint, 0.2))
	hx := bar.X + k.hue*bar.W
	c.Paint.Fill(geom.Rect{X: hx - 2, Y: bar.Y - 2, W: 4, H: bar.H + 4}, 2, white)

	k.hex.Draw(c, field)
	if k.hex.Value != k.typed {
		k.typed = k.hex.Value
		if rgb, ok := people.ParseColor(k.typed); ok {
			k.hue, k.s, k.v = rgbToHSV(rgb)
			k.loaded = k.typed
			if k.OnChange != nil {
				k.OnChange(k.typed)
			}
		}
	}
}

func (k *ColorPicker) dragArea(c *Context, r geom.Rect) {
	if c.In.Pressed && c.Hovered(r) {
		c.Claim()
		k.area = true
	}
	if !c.In.Down {
		k.area = false
	}
	if k.area {
		s := clamp01((c.In.MouseX - r.X) / r.W)
		v := 1 - clamp01((c.In.MouseY-r.Y)/r.H)
		if s != k.s || v != k.v {
			k.s, k.v = s, v
			k.emit()
		}
	}
}

func (k *ColorPicker) dragBar(c *Context, r geom.Rect) {
	if c.In.Pressed && c.Hovered(r) {
		c.Claim()
		k.bar = true
	}
	if !c.In.Down {
		k.bar = false
	}
	if k.bar {
		if hue := min(clamp01((c.In.MouseX-r.X)/r.W), 0.9999); hue != k.hue {
			k.hue = hue
			k.emit()
		}
	}
}

func (k *ColorPicker) fieldHeight(c *Context) float32 {
	k.hex.MaxLength, k.hex.Inset = 7, true
	return k.hex.Measure(c, 0).H
}

func clamp01(x float32) float32 { return min(max(x, 0), 1) }

func hexOf(c color.RGBA) string {
	const digits = "0123456789abcdef"
	return string([]byte{'#', digits[c.R>>4], digits[c.R&15], digits[c.G>>4], digits[c.G&15], digits[c.B>>4], digits[c.B&15]})
}

// hsvToRGB takes hue, saturation and value each from 0 to 1.
func hsvToRGB(h, s, v float32) color.RGBA {
	h = (h - float32(math.Floor(float64(h)))) * 6
	i := int(h)
	f := h - float32(i)
	p, q, t := v*(1-s), v*(1-s*f), v*(1-s*(1-f))
	var r, g, b float32
	switch i {
	case 0:
		r, g, b = v, t, p
	case 1:
		r, g, b = q, v, p
	case 2:
		r, g, b = p, v, t
	case 3:
		r, g, b = p, q, v
	case 4:
		r, g, b = t, p, v
	default:
		r, g, b = v, p, q
	}
	return color.RGBA{uint8(r*255 + 0.5), uint8(g*255 + 0.5), uint8(b*255 + 0.5), 255}
}

func rgbToHSV(c color.RGBA) (h, s, v float32) {
	r, g, b := float32(c.R)/255, float32(c.G)/255, float32(c.B)/255
	hi, lo := max(r, g, b), min(r, g, b)
	d := hi - lo
	v = hi
	if hi > 0 {
		s = d / hi
	}
	switch {
	case d == 0:
	case hi == r:
		h = (g - b) / d / 6
	case hi == g:
		h = ((b-r)/d + 2) / 6
	default:
		h = ((r-g)/d + 4) / 6
	}
	if h < 0 {
		h++
	}
	return h, s, v
}
