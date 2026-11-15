package channels

import (
	"harmony/v2/internal/screens/serveradmin"
	"harmony/v2/internal/ui/widget"
)

// deleteAccountLabel has no translation in the Electron client either.
const deleteAccountLabel = "Delete account"

// openMemberMenu is what a right-click on somebody in the member list offers: a private message, their page in the Server dialog, and
// for the owner removing the account.
func (s *Screen) openMemberMenu(c *widget.Context, id int, name string) {
	st := s.Session.State()
	if id == st.Me.ID {
		return
	}
	var items []widget.MenuItem
	if s.PrivateAvailable() {
		items = append(items, widget.MenuItem{Icon: "chat-circle-dots", Label: c.T("dm.send"), OnPick: func() { s.openWith(c, id) }})
	}
	if serveradmin.MembersAllowed(st.Actor) {
		items = append(items, widget.MenuItem{Icon: "key", Label: c.T("server_admin.manage_member"), OnPick: func() {
			s.OnServerDialog(serveradmin.Target{Tab: serveradmin.TabMembers, Kind: "member", ID: id})
		}})
	}
	if serveradmin.CanDeleteAccount(st, id) {
		items = append(items, widget.MenuItem{Icon: "trash", Label: deleteAccountLabel, Danger: true, OnPick: func() { serveradmin.DeleteAccount(c, s.Session, id) }})
	}
	if len(items) == 0 {
		return
	}
	menu := &s.dm.member
	menu.Head, menu.Items = name, items
	menu.OpenAt(c.In.MouseX, c.In.MouseY)
}
