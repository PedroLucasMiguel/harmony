// Package tray puts Harmony's icon in the system tray (the menu bar on a Mac) with a menu, and shows balloons beside it where the system has no better notifications. Each system has its own file; none needs cgo.
package tray

// Item is one line of the tray's menu.
type Item struct {
	Label     string
	Checked   bool
	Disabled  bool
	Separator bool
	OnClick   func()
}

// Options is what the tray needs when it starts.
type Options struct {
	Tooltip string
	Icon    []byte
	// OnOpen is a click on the icon itself (a Mac shows the menu instead).
	OnOpen func()
	// Menu builds the menu when it is about to show, so it always reflects the present.
	Menu func() []Item
}

// Tray is the icon in the notification area.
type Tray struct{ impl impl }

type impl interface {
	setIcon(png []byte)
	setTooltip(text string)
	setMenu(items []Item)
	setBadge(count int)
	balloon(title, body string, onClick func())
	close()
}

// Start puts the icon up; it returns nil when this system has no tray to put it in. On a Mac it must be called from the thread the window runs on.
func Start(opt Options) *Tray {
	i := start(opt)
	if i == nil {
		return nil
	}
	return &Tray{impl: i}
}

func (t *Tray) SetIcon(png []byte) {
	if t != nil {
		t.impl.setIcon(png)
	}
}

func (t *Tray) SetTooltip(text string) {
	if t != nil {
		t.impl.setTooltip(text)
	}
}

// SetMenu replaces the menu; a Mac shows it for a click on the icon, the others ask Options.Menu when it is wanted.
func (t *Tray) SetMenu(items []Item) {
	if t != nil {
		t.impl.setMenu(items)
	}
}

// SetBadge shows a count of unread mentions beside the icon (the menu bar's text on a Mac, the tooltip elsewhere); 0 clears it.
func (t *Tray) SetBadge(count int) {
	if t != nil {
		t.impl.setBadge(count)
	}
}

// Balloon shows a notification from the icon, where the system has no other way; OnClick is heard where the system tells.
func (t *Tray) Balloon(title, body string, onClick func()) {
	if t != nil {
		t.impl.balloon(title, body, onClick)
	}
}

func (t *Tray) Close() {
	if t != nil {
		t.impl.close()
	}
}
