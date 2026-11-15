package channels

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/app"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const statusHit = 18

// statusPicker is the menu behind the dot on your picture: online, idle, do not disturb, invisible.
type statusPicker struct {
	menu  widget.ContextMenu
	at    geom.Rect
	picks [4]func()
	set   bool
}

// drawStatusDot makes the dot on the picture a button that opens the status menu; face is the picture's box.
func (s *Screen) drawStatusDot(c *widget.Context, face geom.Rect) {
	p := &s.picker
	hit := geom.Rect{X: face.Right() - 2.6 - statusHit/2, Y: face.Bottom() - 2.6 - statusHit/2, W: statusHit, H: statusHit}
	p.at = hit
	if c.Hovered(hit) {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
	if c.Clicked(hit) {
		c.Claim()
		s.openStatusMenu(c)
	}
	p.menu.Show(c)
}

func (s *Screen) openStatusMenu(c *widget.Context) {
	p := &s.picker
	if !p.set {
		for i, status := range app.Statuses {
			p.picks[i] = func() { go func() { _ = s.Session.SetStatus(status) }() }
		}
		p.set = true
	}
	current := s.Session.OwnStatus()
	p.menu.Head, p.menu.NameOnly = c.T("status.menu_title"), true
	p.menu.Items = p.menu.Items[:0]
	for i, status := range app.Statuses {
		label := c.T("status." + status)
		if status == current {
			label = "• " + label
		}
		p.menu.Items = append(p.menu.Items, widget.MenuItem{Label: label, OnPick: p.picks[i]})
	}
	p.menu.OpenAt(p.at.X, p.at.Y)
}

// ownPresence is how the dot on your own picture shows: what you chose, which the server may have turned to idle.
func (s *Screen) ownPresence(shown widget.Presence) (widget.Presence, string) {
	if s.Session.OwnStatus() == "invisible" {
		return widget.Offline, "invisible"
	}
	return shown, ""
}
