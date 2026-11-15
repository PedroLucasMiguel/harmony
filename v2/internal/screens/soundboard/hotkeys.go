package soundboard

import (
	"strconv"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/hotkey"
	"harmony/v2/internal/ui/widget"
)

// Hotkeys is where a clip's key is kept and chosen: the desktop's key bindings, and the question that asks for a combination.
type Hotkeys interface {
	Binding(id string) string
	SetBinding(id, accelerator string)
	// Record asks the person to press a combination for the action and binds it; done is called, from the interface's thread, once it was answered and the question is gone.
	Record(c *widget.Context, id, name string, done func())
}

func clipAction(clip hclient.Clip) string { return "clip:" + strconv.Itoa(clip.ID) }

// openMenu is the menu of a clip: set, change or remove its hotkey.
func (b *Board) openMenu(clip hclient.Clip, x, y float32) {
	c := b.ctx
	action := clipAction(clip)
	current := b.Keys.Binding(action)
	label := c.T("app.set_hotkey")
	if current != "" {
		label = c.T("app.change_hotkey", "current", hotkey.Format(current))
	}
	b.menu.Head, b.menu.NameOnly = clip.Name, true
	b.menu.Items = append(b.menu.Items[:0], widget.MenuItem{Label: label, OnPick: func() { b.Keys.Record(c, action, clip.Name, func() { b.stale = true }) }})
	if current != "" {
		b.menu.Items = append(b.menu.Items, widget.MenuItem{Label: c.T("app.remove_hotkey"), OnPick: func() { b.Keys.SetBinding(action, ""); b.stale = true }})
	}
	b.menu.OpenAt(x, y)
}
