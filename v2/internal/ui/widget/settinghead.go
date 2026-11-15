package widget

import "harmony/v2/internal/ui/geom"

// SettingHead is a title with its tools on the right, as the top of a SettingCard has, for a second setting inside the same card.
type SettingHead struct {
	Title string
	Tools Component
	// Top is the space above it.
	Top float32
}

func (h SettingHead) height(c *Context, width float32) float32 {
	height := float32(cardHeadHeight)
	if h.Tools != nil {
		height = max(height, h.Tools.Measure(c, width).H)
	}
	return height
}

func (h SettingHead) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: h.Top + h.height(c, maxWidth)}
}

func (h SettingHead) Draw(c *Context, r geom.Rect) {
	height := h.height(c, r.W)
	y := r.Y + h.Top
	if h.Tools != nil {
		size := h.Tools.Measure(c, r.W)
		h.Tools.Draw(c, geom.Rect{X: r.Right() - size.W, Y: y + (height-size.H)/2, W: size.W, H: size.H})
	}
	c.Paint.Text(h.Title, r.X, y+(height-cardTitleLine)/2, cardTitleLine, cardTitleStyle, c.Theme.Text)
}
