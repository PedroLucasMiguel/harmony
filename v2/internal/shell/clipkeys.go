package shell

import (
	"harmony/v2/internal/desktop"
	"harmony/v2/internal/screens/settings"
	"harmony/v2/internal/ui/widget"
)

// clipKeys gives the soundboard's clips the desktop's hotkeys and the settings' question for a key combination.
type clipKeys struct{ *desktop.Desktop }

func (k clipKeys) Record(c *widget.Context, id, name string, done func()) {
	settings.RecordHotkey(c, k.Desktop, id, name, func() {
		c.CloseModal()
		done()
	})
}
