package hclient

import "testing"

func roleList() []Role {
	return []Role{
		{ID: 10, Name: "Mod", Position: 0, Permissions: []string{"roles.hierarchy", "users.kick"}, Assignable: []int{12}},
		{ID: 11, Name: "Helper", Position: 1, Permissions: []string{"users.mute"}},
		{ID: 12, Name: "Guest", Position: 2},
		{ID: 13, Name: "Boss", Position: 3, Admin: true},
	}
}

func TestRank(t *testing.T) {
	roles := roleList()
	owner := ActorOf(User{Role: "owner"}, roles)
	super := ActorOf(User{Role: "admin"}, roles)
	mod := ActorOf(User{Role: "member", Roles: []int{10}}, roles)
	helper := ActorOf(User{Role: "member", Roles: []int{11, 12}}, roles)
	nobody := ActorOf(User{Role: "member"}, roles)
	if !owner.Outranks(super) || !super.Outranks(mod) || !mod.Outranks(helper) || !helper.Outranks(nobody) {
		t.Fatal("owner > super admin > top role > lower role > nobody")
	}
	if mod.Outranks(mod) || nobody.Outranks(nobody) {
		t.Fatal("equals do not outrank each other")
	}
}

func TestManageAndAssign(t *testing.T) {
	roles := roleList()
	mod := ActorOf(User{Role: "member", Roles: []int{10}}, roles)
	helper := ActorOf(User{Role: "member", Roles: []int{11}}, roles)
	boss := ActorOf(User{Role: "member", Roles: []int{13}}, roles)
	if mod.CanManageRole(roles[0]) || !mod.CanManageRole(roles[1]) {
		t.Fatal("a moderator manages the roles below their own, not their own")
	}
	if helper.CanManageRole(roles[2]) {
		t.Fatal("managing roles needs roles.hierarchy")
	}
	if !mod.CanAssign(roles[2]) || mod.CanAssign(roles[1]) || mod.CanAssign(roles[0]) {
		t.Fatal("a role can be handed out only if listed, and only below the actor")
	}
	if !boss.CanAssign(roles[2]) && boss.Rank > RoleRank(roles[2]) {
		t.Fatal("an admin role hands out every role below it")
	}
	if boss.CanAssign(roles[0]) {
		t.Fatal("an admin role still cannot hand out one above it")
	}
}

func TestReorder(t *testing.T) {
	roles := roleList()
	mod := ActorOf(User{Role: "member", Roles: []int{10}}, roles)
	helper := ActorOf(User{Role: "member", Roles: []int{11}}, roles)
	super := ActorOf(User{Role: "admin"}, roles)
	if !mod.CanReorderTo(roles, []int{10, 12, 11, 13}) {
		t.Fatal("roles below the actor's own may be moved")
	}
	if mod.CanReorderTo(roles, []int{11, 10, 12, 13}) {
		t.Fatal("the actor's own role may not move")
	}
	if helper.CanReorderTo(roles, []int{10, 11, 13, 12}) {
		t.Fatal("no roles.hierarchy, no reordering")
	}
	if !super.CanReorderTo(roles, []int{13, 12, 11, 10}) {
		t.Fatal("a super admin may reorder everything")
	}
}

func TestPermissionsAndAwards(t *testing.T) {
	roles := roleList()
	roles[1].AssignableBadges = []int{5}
	helper := ActorOf(User{Role: "member", Roles: []int{11}}, roles)
	boss := ActorOf(User{Role: "member", Roles: []int{13}}, roles)
	if !helper.Can("users.mute") || helper.Can("users.kick") || !boss.Can("users.kick") {
		t.Fatal("permissions come from the roles held; an admin role has them all")
	}
	if !helper.CanAward(5) || helper.CanAward(6) || !boss.CanAward(6) {
		t.Fatal("badges come from the roles' lists; an admin awards any")
	}
	if !helper.CanAdminister() || ActorOf(User{Role: "member"}, roles).CanAdminister() {
		t.Fatal("the dialog is for those with something to do in it")
	}
}
