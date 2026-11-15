package widget

// Layers answer Escape one at a time. A popover, menu or dialog that is open marks itself with Layer as it is drawn,
// and Escape closes only the one drawn last (the one on top) as of the frame before; with none open it is the screen's.

// beginLayers keeps which layer was on top last frame and starts the list afresh.
func (c *Context) beginLayers() {
	c.top = nil
	if n := len(c.layers); n > 0 {
		c.top = c.layers[n-1]
	}
	c.layers = c.layers[:0]
}

// Layer marks key, a pointer to the component, as open and drawn now.
func (c *Context) Layer(key any) { c.layers = append(c.layers, key) }

// EscapeFor reports whether Escape was pressed while key is the layer on top.
func (c *Context) EscapeFor(key any) bool { return c.In.Escape && c.top == key }

// EscapeBase reports whether Escape was pressed with no layer open, for what belongs to the screen itself.
func (c *Context) EscapeBase() bool { return c.In.Escape && c.top == nil }
