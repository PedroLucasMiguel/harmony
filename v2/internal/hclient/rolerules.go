package hclient

import "slices"

// The rules below mirror server/src/roles.js and client/src/renderer/roles.js. They decide only what to offer; the
// server decides what is allowed, on every request.

const (
	roleBase       = 1_000_000
	rankSuperAdmin = 10_000_000
	rankOwner      = 100_000_000
)

// Actor is what one account may do, worked out from the roles as they are now.
type Actor struct {
	Owner      bool
	SuperAdmin bool
	// Everything is an owner or a super admin: no role limits them.
	Everything bool
	// Admin is Everything, or a role that says admin.
	Admin bool
	// Roles are the roles held, top of the hierarchy first.
	Roles       []Role
	HasTop      bool
	TopPosition int
	Rank        int

	permissions      []string
	assignable       []int
	assignableBadges []int
}

// SortRoles is the roles in hierarchy order, top first.
func SortRoles(roles []Role) []Role {
	ordered := slices.Clone(roles)
	slices.SortStableFunc(ordered, func(a, b Role) int { return a.Position - b.Position })
	return ordered
}

// RolesOf is the roles an account holds, top of the hierarchy first.
func RolesOf(user User, roles []Role) []Role {
	var held []Role
	for _, r := range SortRoles(roles) {
		if slices.Contains(user.Roles, r.ID) {
			held = append(held, r)
		}
	}
	return held
}

// ActorOf works out what an account may do from the roles list as it is now.
func ActorOf(user User, roles []Role) Actor {
	a := Actor{
		Owner:      user.Role == "owner",
		SuperAdmin: user.Role == "admin",
		Roles:      RolesOf(user, roles),
	}
	a.Everything = a.Owner || a.SuperAdmin
	a.Admin = a.Everything
	for _, r := range a.Roles {
		a.Admin = a.Admin || r.Admin
		a.permissions = append(a.permissions, r.Permissions...)
		a.assignable = append(a.assignable, r.Assignable...)
		a.assignableBadges = append(a.assignableBadges, r.AssignableBadges...)
	}
	if len(a.Roles) > 0 {
		a.HasTop, a.TopPosition = true, a.Roles[0].Position
	}
	switch {
	case a.Owner:
		a.Rank = rankOwner
	case a.SuperAdmin:
		a.Rank = rankSuperAdmin
	case a.HasTop:
		a.Rank = roleBase - a.TopPosition
	}
	return a
}

// Can is whether the account holds a permission.
func (a Actor) Can(permission string) bool {
	return a.Admin || slices.Contains(a.permissions, permission)
}

// CanAward is whether the account may hand out a badge: admins any, the rest the ones a role lists.
func (a Actor) CanAward(badgeID int) bool {
	return a.Admin || slices.Contains(a.assignableBadges, badgeID)
}

// HoldsAssignable is whether one of the account's roles lists this role as one it can hand out.
func (a Actor) HoldsAssignable(roleID int) bool { return slices.Contains(a.assignable, roleID) }

// HasAssignable is whether any of the account's roles can hand out another role.
func (a Actor) HasAssignable() bool { return len(a.assignable) > 0 }

// HasAssignableBadges is whether any of the account's roles can award a badge.
func (a Actor) HasAssignableBadges() bool { return len(a.assignableBadges) > 0 }

// RoleRank is what a role is worth against an account's rank.
func RoleRank(role Role) int { return roleBase - role.Position }

// Outranks is whether the actor may act on the target's account (mute, kick, ban, hand out roles): strictly higher.
func (a Actor) Outranks(target Actor) bool { return a.Rank > target.Rank }

// CanManageRole is whether the actor may edit, delete or move a role: only the ones below them.
func (a Actor) CanManageRole(role Role) bool {
	return a.Everything || (a.Can("roles.hierarchy") && a.Rank > RoleRank(role))
}

// CanAssign is whether the actor may put a role on somebody, or take it off.
func (a Actor) CanAssign(role Role) bool {
	if a.Everything {
		return true
	}
	if a.Rank <= RoleRank(role) {
		return false
	}
	return slices.Contains(a.assignable, role.ID) || slices.ContainsFunc(a.Roles, func(r Role) bool { return r.Admin })
}

// CanReorderTo is whether the actor may make the list ids out of the current one: the roles from the top down to
// their own, theirs included, have to stay where they are.
func (a Actor) CanReorderTo(current []Role, ids []int) bool {
	if !a.Can("roles.hierarchy") {
		return false
	}
	if a.Everything {
		return true
	}
	frozen := -1
	if a.HasTop {
		frozen = a.TopPosition
	}
	for i := 0; i <= frozen; i++ {
		inCurrent, inIDs := i < len(current), i < len(ids)
		if inCurrent != inIDs || (inCurrent && ids[i] != current[i].ID) {
			return false
		}
	}
	return true
}

// CanAdminister is whether anything in the server dialog is of use to the account.
func (a Actor) CanAdminister() bool {
	if a.Owner || a.Admin || a.HasAssignable() || a.HasAssignableBadges() {
		return true
	}
	for _, p := range []string{
		"roles.hierarchy", "channels.create", "channels.edit", "channels.password", "channels.delete",
		"users.kick", "users.ban", "badges.create", "badges.edit",
	} {
		if a.Can(p) {
			return true
		}
	}
	return false
}
