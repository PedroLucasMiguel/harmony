// Package people is who is on the server as the interface draws them: by id and by name, with their picture, banner and how
// their name looks already worked out. Readers never block: a change swaps in a whole new snapshot.
package people

import (
	"image/color"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/paint"
)

// Kind is how a name is coloured.
type Kind uint8

const (
	Plain Kind = iota
	Solid
	Moving
)

// Style is how somebody's name is drawn: in a colour of its own or its highest role's, and in a font of its own.
type Style struct {
	Kind   Kind
	Color  color.RGBA
	Ring   []color.RGBA
	Speed  float32
	Family paint.Family
}

// Entry is one account with what the interface needs of it.
type Entry struct {
	hclient.Account
	Style Style
}

// Name is what to show for the person.
func (e *Entry) Name() string { return e.Account.Name() }

// Banner is the banner's picture hash.
func (e *Entry) Banner() string { return e.BannerHash }

// Dim is how dim the banner is drawn, 0 to 1.
func (e *Entry) Dim() float32 {
	if e.BannerDim == nil {
		return 0
	}
	return float32(*e.BannerDim) / 100
}

type snapshot struct {
	byID   map[int]*Entry
	byName map[string]*Entry
	roles  []hclient.Role
}

type Directory struct {
	mu       sync.Mutex
	accounts []hclient.Account
	roles    []hclient.Role
	snap     atomic.Pointer[snapshot]
}

func New() *Directory {
	d := &Directory{}
	d.snap.Store(&snapshot{})
	return d
}

// SetAccounts replaces the accounts; the same slice again costs nothing.
func (d *Directory) SetAccounts(accounts []hclient.Account) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if sameSlice(d.accounts, accounts) {
		return
	}
	d.accounts = accounts
	d.rebuild()
}

func (d *Directory) SetRoles(roles []hclient.Role) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if sameSlice(d.roles, roles) {
		return
	}
	d.roles = roles
	d.rebuild()
}

func sameSlice[T any](a, b []T) bool { return len(a) == len(b) && (len(a) == 0 || &a[0] == &b[0]) }

func (d *Directory) rebuild() {
	roles := slices.Clone(d.roles)
	slices.SortStableFunc(roles, func(a, b hclient.Role) int { return a.Position - b.Position })
	s := &snapshot{byID: make(map[int]*Entry, len(d.accounts)), byName: make(map[string]*Entry, 2*len(d.accounts)), roles: roles}
	for _, a := range d.accounts {
		e := &Entry{Account: a, Style: styleOf(a, roles)}
		s.byID[a.ID] = e
		for _, name := range [2]string{a.DisplayName, a.Nickname} {
			if name != "" {
				s.byName[name] = e
			}
		}
	}
	d.snap.Store(s)
}

// ByID is the account with that id, or nil.
func (d *Directory) ByID(id int) *Entry { return d.snap.Load().byID[id] }

// ByName is the account called that, by display name or username, or nil.
func (d *Directory) ByName(name string) *Entry { return d.snap.Load().byName[name] }

// Avatar is the hash of the picture of the person with that id, or of the one called name when the id is 0.
func (d *Directory) Avatar(id int, name string) string {
	s := d.snap.Load()
	if id != 0 {
		if e := s.byID[id]; e != nil {
			return e.AvatarHash
		}
		return ""
	}
	if e := s.byName[name]; e != nil {
		return e.AvatarHash
	}
	return ""
}

// Role is the role with that id, or nil.
func (d *Directory) Role(id int) *hclient.Role {
	s := d.snap.Load()
	for i := range s.roles {
		if s.roles[i].ID == id {
			return &s.roles[i]
		}
	}
	return nil
}

// RolesOf are the roles the account holds, highest first.
func (d *Directory) RolesOf(e *Entry) []hclient.Role {
	var out []hclient.Role
	for _, r := range d.snap.Load().roles {
		if slices.Contains(e.Roles, r.ID) {
			out = append(out, r)
		}
	}
	return out
}

func styleOf(a hclient.Account, roles []hclient.Role) Style {
	st := Style{Family: paint.FamilyOf(a.NameFont)}
	look := a.NameColor
	if look == nil {
		for _, r := range roles {
			if slices.Contains(a.Roles, r.ID) {
				look = RoleLook(r)
				break
			}
		}
	}
	st.apply(look)
	return st
}

// RoleLook is how a role colours the names of those who hold it: its gradient or rainbow, else its plain colour.
func RoleLook(r hclient.Role) *hclient.NameStyle {
	if r.Style != nil {
		return r.Style
	}
	if r.Color != "" {
		return &hclient.NameStyle{Mode: "solid", Color: r.Color}
	}
	return nil
}

// LookOf is the style a name takes from a look alone, for a role or a name colour being edited.
func LookOf(look *hclient.NameStyle) Style {
	var st Style
	st.apply(look)
	return st
}

var rainbow = parseAll("#ff4d4d", "#ffa64d", "#ffe14d", "#5ce65c", "#4dd2ff", "#6b7bff", "#c04dff", "#ff4d4d")

const defaultSpeed = 6

func (st *Style) apply(look *hclient.NameStyle) {
	if look == nil {
		return
	}
	switch look.Mode {
	case "solid":
		if c, ok := ParseColor(look.Color); ok {
			st.Kind, st.Color = Solid, c
		}
	case "gradient":
		ring := parseAll(look.Colors...)
		if len(ring) >= 2 {
			st.Kind, st.Ring, st.Speed = Moving, append(ring, ring[0]), speedOf(look)
		}
	case "rainbow":
		st.Kind, st.Ring, st.Speed = Moving, rainbow, speedOf(look)
	}
}

func speedOf(look *hclient.NameStyle) float32 {
	if look.Speed > 0 {
		return float32(look.Speed)
	}
	return defaultSpeed
}

func parseAll(hex ...string) []color.RGBA {
	out := make([]color.RGBA, 0, len(hex)+1)
	for _, h := range hex {
		if c, ok := ParseColor(h); ok {
			out = append(out, c)
		}
	}
	return out
}

// ParseColor reads #rrggbb.
func ParseColor(s string) (color.RGBA, bool) {
	if len(s) != 7 || s[0] != '#' {
		return color.RGBA{}, false
	}
	n, err := strconv.ParseUint(strings.ToLower(s[1:]), 16, 32)
	if err != nil {
		return color.RGBA{}, false
	}
	return color.RGBA{uint8(n >> 16), uint8(n >> 8), uint8(n), 255}, true
}

// RoleStyle is how a name would be drawn from the roles alone, without the person's own colour.
func (d *Directory) RoleStyle(e *Entry) Style {
	st := Style{Family: paint.FamilyOf(e.NameFont)}
	for _, r := range d.snap.Load().roles {
		if slices.Contains(e.Roles, r.ID) {
			st.apply(RoleLook(r))
			break
		}
	}
	return st
}
