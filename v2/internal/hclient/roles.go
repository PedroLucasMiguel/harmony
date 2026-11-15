package hclient

import "slices"

// NameStyle is how a name is drawn when it is more than a plain colour: a moving gradient, or the rainbow.
type NameStyle struct {
	Mode   string   `json:"mode"`
	Color  string   `json:"color,omitempty"`
	Colors []string `json:"colors,omitempty"`
	Speed  float64  `json:"speed,omitempty"`
}

// Role is what the server says about one of its roles.
type Role struct {
	ID               int        `json:"id"`
	Name             string     `json:"name"`
	Color            string     `json:"color"`
	Position         int        `json:"position"`
	Admin            bool       `json:"admin"`
	Permissions      []string   `json:"permissions"`
	Assignable       []int      `json:"assignable"`
	AssignableBadges []int      `json:"assignableBadges"`
	Style            *NameStyle `json:"style"`
}

// IsAdmin is whether no role limits the signed-in person: an owner, a super admin, or somebody holding a role that says admin.
func (h Hello) IsAdmin() bool {
	if h.User.Role == "owner" || h.User.Role == "admin" {
		return true
	}
	for _, held := range h.User.Roles {
		for _, r := range h.Roles {
			if r.ID == held && r.Admin {
				return true
			}
		}
	}
	return false
}

// Can is whether the signed-in person holds a permission: every admin does, and so does anyone with a role that lists it.
func (h Hello) Can(permission string) bool {
	if h.IsAdmin() {
		return true
	}
	for _, held := range h.User.Roles {
		for _, r := range h.Roles {
			if r.ID == held && slices.Contains(r.Permissions, permission) {
				return true
			}
		}
	}
	return false
}
