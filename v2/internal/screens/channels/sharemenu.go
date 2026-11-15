package channels

import (
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

const shareMenuHeight = 92

// shareMenu is what the share button asks while you are sharing: change what is shared, or stop.
type shareMenu struct {
	menu widget.ContextMenu
	at   geom.Rect
}

// pressShare starts a share, or opens the menu over the button while one runs.
func (s *Screen) pressShare(sharing bool) {
	if !sharing {
		go s.toggleShare(false)
		return
	}
	m := &s.shareMenuState
	m.menu.Items = m.menu.Items[:0]
	m.menu.Items = append(m.menu.Items,
		widget.MenuItem{Label: s.shareLabels[0], OnPick: func() {
			if s.ShareHooks.Change != nil {
				s.ShareHooks.Change()
			}
		}},
		widget.MenuItem{Label: s.shareLabels[1], Danger: true, OnPick: func() { go s.Session.StopShare() }},
	)
	m.menu.OpenAt(m.at.X, m.at.Y-shareMenuHeight)
}

// showShareMenu remembers where the share button is and draws its menu.
func (s *Screen) showShareMenu(c *widget.Context, button geom.Rect) {
	m := &s.shareMenuState
	m.at = button
	s.shareLabels = [2]string{c.T("app.change_source"), c.T("app.stop_streaming")}
	m.menu.Show(c)
}
