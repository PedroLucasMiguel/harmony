package widget

import "harmony/v2/internal/ui/geom"

const (
	editorPad    = 16
	editorRadius = 10
	editorGap    = 11.2
)

// EditorCard is what is being edited on a page of the Server dialog: a card with a head over a rule, then the fields. It scrolls inside
// the height it is given. Keep the same card between builds so that its scroll stays.
type EditorCard struct {
	Scroll Scroll
	body   *Column
	padded Padded
}

// Set makes the card's content: head over its rule, then the fields.
func (e *EditorCard) Set(head Component, body ...Component) {
	children := make([]Component, 0, len(body)+1)
	if head != nil {
		children = append(children, headRule{head})
	}
	e.body = Col(editorGap, append(children, body...)...)
	e.padded = Padded{Left: editorPad, Top: editorPad, Right: editorPad, Bottom: editorPad, Child: e.body}
}

func (e *EditorCard) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: e.padded.Measure(c, maxWidth-2*c.Hairline()).H + 2*c.Hairline()}
}

func (e *EditorCard) Draw(c *Context, r geom.Rect) {
	c.Paint.Fill(r, editorRadius, c.Theme.Surface)
	c.Paint.Stroke(r, editorRadius, c.Hairline(), c.Theme.Border)
	e.Scroll.Child = &e.padded
	e.Scroll.Bar = true
	e.Scroll.Draw(c, r.InsetAll(c.Hairline()))
}

type headRule struct{ child Component }

func (h headRule) Measure(c *Context, maxWidth float32) geom.Size {
	return geom.Size{W: maxWidth, H: h.child.Measure(c, maxWidth).H + editorGap + c.Hairline()}
}

func (h headRule) Draw(c *Context, r geom.Rect) {
	inner := h.child.Measure(c, r.W).H
	h.child.Draw(c, geom.Rect{X: r.X, Y: r.Y, W: r.W, H: inner})
	c.Paint.Fill(geom.Rect{X: r.X, Y: r.Bottom() - c.Hairline(), W: r.W, H: c.Hairline()}, 0, c.Theme.Border)
}
