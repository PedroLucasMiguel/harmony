package settings

import (
	"harmony/v2/internal/desktop"
	"harmony/v2/internal/hotkey"
	"harmony/v2/internal/ui/widget"
)

// RecordHotkey asks for a key combination and binds the action to it (or unbinds it); done is called once it was answered,
// to put back whatever was showing.
func RecordHotkey(c *widget.Context, d *desktop.Desktop, id, name string, done func()) {
	d.Pause()
	title := c.T("hotkey_recorder.press_the_combination_you")
	finish := func(accelerator string, apply bool) {
		if apply {
			d.SetBinding(id, accelerator)
		}
		d.Resume()
		done()
	}
	rec := &recorder{allowBare: id == desktop.ActionPTT && hotkey.Listens()}
	rec.done = func(accelerator string) { c.Post(func() { finish(accelerator, true) }) }
	prompt := &widget.Prompt{
		Title:    name,
		Text:     title,
		Body:     rec,
		OnCancel: func() { finish("", false) },
		Buttons: []*widget.Button{
			{Label: c.T("hotkey_recorder_clear.remove_hotkey"), Variant: widget.Ghost, OnClick: func() { finish("", true) }},
			{Label: c.T("hotkey_recorder_cancel.cancel"), Variant: widget.Ghost, OnClick: func() { finish("", false) }},
		},
	}
	c.OpenModal(prompt)
}
