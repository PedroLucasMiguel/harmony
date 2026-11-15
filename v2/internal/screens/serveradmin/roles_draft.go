package serveradmin

import (
	"slices"
	"strings"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/people"
	"harmony/v2/internal/ui/widget"
)

const defaultRoleColor = "#99aab5"

// roleDraft is what the role editor holds: the role on show, or a new one, with the changes made and not yet confirmed.
type roleDraft struct {
	Name             string
	Look             widget.NameStyleValue
	Admin            bool
	Permissions      []string
	Assignable       []int
	AssignableBadges []int
}

func draftOf(r *hclient.Role) roleDraft {
	d := roleDraft{Look: widget.NameStyleValue{Mode: "solid", Color: defaultRoleColor}}
	if r == nil {
		return d
	}
	d.Name, d.Admin = r.Name, r.Admin
	d.Permissions = slices.Clone(r.Permissions)
	d.Assignable = slices.Clone(r.Assignable)
	d.AssignableBadges = slices.Clone(r.AssignableBadges)
	d.Look.Color = r.Color
	if s := r.Style; s != nil && s.Mode != "solid" {
		d.Look = widget.NameStyleValue{Mode: s.Mode, Color: r.Color, Colors: slices.Clone(s.Colors), Speed: s.Speed}
	}
	return d
}

// toggle puts v in the list or takes it out.
func toggle[T comparable](list []T, v T, on bool) []T {
	list = slices.DeleteFunc(list, func(x T) bool { return x == v })
	if on {
		list = append(list, v)
	}
	return list
}

// body is the request that would change the role as the draft has it. It is nil while the colour is half typed or the name is
// empty: there is nothing to send yet.
func (d roleDraft) body() *hclient.RoleBody {
	if strings.TrimSpace(d.Name) == "" {
		return nil
	}
	return d.bare()
}

// bare is body without the check of the name, which the server answers in its own words when a role is made.
func (d roleDraft) bare() *hclient.RoleBody {
	look := d.Look
	color := look.Color
	var style *hclient.NameStyle
	switch look.Mode {
	case "gradient":
		if len(look.Colors) == 0 {
			return nil
		}
		color = look.Colors[0]
		style = &hclient.NameStyle{Mode: "gradient", Colors: slices.Clone(look.Colors), Speed: speedOrDefault(look.Speed)}
	case "rainbow":
		style = &hclient.NameStyle{Mode: "rainbow", Speed: speedOrDefault(look.Speed)}
	}
	if _, ok := people.ParseColor(color); !ok {
		return nil
	}
	for _, c := range look.Colors {
		if _, ok := people.ParseColor(c); !ok && look.Mode == "gradient" {
			return nil
		}
	}
	return &hclient.RoleBody{
		Name: d.Name, Color: color, Style: style, Admin: d.Admin,
		Permissions: nonNilSlice(slices.Clone(d.Permissions)), Assignable: nonNilSlice(slices.Clone(d.Assignable)),
		AssignableBadges: nonNilSlice(slices.Clone(d.AssignableBadges)),
	}
}

func speedOrDefault(s float64) float64 {
	if s <= 0 {
		return 6
	}
	return s
}

func nonNilSlice[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

// lookOf is the look the role's name is drawn in, from the draft.
func (d roleDraft) lookOf() people.Style {
	return people.StyleFor(d.Look.Mode, d.Look.Color, d.Look.Colors, d.Look.Speed)
}
