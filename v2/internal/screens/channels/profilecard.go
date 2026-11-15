package channels

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/screens/serveradmin"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/widget"
)

// drawProfileCard keeps the profile card wired to this screen and draws it over everything.
func (s *Screen) drawProfileCard(c *widget.Context) {
	k := &s.profile
	if k.Session == nil {
		k.Session = s.Session
		k.CanMessage = s.PrivateAvailable
		k.Message = func(c *widget.Context, id int) { s.openWith(c, id) }
		k.CanManage = func(id int) bool { return serveradmin.MembersAllowed(s.Session.State().Actor) }
		k.Manage = func(c *widget.Context, id int) {
			s.OnServerDialog(serveradmin.Target{Tab: serveradmin.TabMembers, Kind: "member", ID: id})
		}
	}
	c.OpenProfile = k.Open
	k.Draw(c)
}

// pressProfile opens the profile card when any of the given areas is pressed, beside the one that was.
func (s *Screen) pressProfile(c *widget.Context, userID int, areas ...geom.Rect) {
	if c.OpenProfile == nil || userID == 0 {
		return
	}
	for _, a := range areas {
		if c.Hovered(a) {
			c.SetCursor(rl.MouseCursorPointingHand)
			if c.Clicked(a) {
				c.Claim()
				c.OpenProfile(userID, a)
			}
		}
	}
}
