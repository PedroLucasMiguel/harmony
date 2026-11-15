package widget

import "harmony/v2/internal/ui/geom"

type Icon struct {
	Name string
	Size float32
	Tone Tone
}

func (i Icon) Measure(*Context, float32) geom.Size { return geom.Size{W: i.Size, H: i.Size} }

func (i Icon) Draw(c *Context, r geom.Rect) {
	c.Paint.Icon(i.Name, geom.Rect{X: r.X, Y: r.Y, W: i.Size, H: i.Size}, i.Tone.Color(c.Theme))
}

type Logo struct {
	Size float32
	Tone Tone
}

func (l Logo) Measure(*Context, float32) geom.Size { return geom.Size{W: l.Size, H: l.Size} }

func (l Logo) Draw(c *Context, r geom.Rect) {
	c.Paint.Mask("logo.png", geom.Rect{X: r.X, Y: r.Y, W: l.Size, H: l.Size}, l.Tone.Color(c.Theme))
}
