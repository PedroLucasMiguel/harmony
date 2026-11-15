package widget

// Focused is whether the field has the keyboard.
func (f *TextField) Focused(c *Context) bool { return c.Focused(&f.focus) }

// Blur takes the keyboard from the field if it has it.
func (f *TextField) Blur(c *Context) {
	if c.Focused(&f.focus) {
		c.Focus(nil)
	}
}

// SetValue replaces the text and puts the caret at its end.
func (f *TextField) SetValue(text string) {
	f.Value = text
	f.ed.place(len([]rune(text)))
}
