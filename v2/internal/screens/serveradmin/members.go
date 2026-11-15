package serveradmin

import (
	"slices"
	"strings"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	membersFilterGap = 11.2
	membersMinHeight = 384
	rowAvatarGap     = 2.94
)

// membersPage is who is on the server, and for each person their roles, badges and the moderation that goes with them. What is
// drawn is made again only when the roster, the roles, the search, the selection or the language changed.
type membersPage struct {
	d *Dialog

	filter   widget.TextField
	list     widget.AdminList
	card     widget.EditorCard
	split    widget.AdminSplit
	title    widget.Component
	selected int

	seen       *app.State
	seenFilter string
	seenSelect int
	seenStrs   any
	stale      bool
	problem    string
}

func newMembers(d *Dialog) *membersPage {
	p := &membersPage{d: d}
	p.filter.Inset = true
	p.split.List = &p.list
	p.split.Height = p.fill
	return p
}

func (p *membersPage) name() string                   { return TabMembers }
func (p *membersPage) icon() string                   { return "users" }
func (p *membersPage) label(c *widget.Context) string { return c.T("server_admin.members") }

func (p *membersPage) visible(a hclient.Actor) bool {
	return a.Admin || a.Can("roles.hierarchy") || a.Can("users.kick") || a.Can("users.ban") || a.HasAssignable() || a.HasAssignableBadges()
}

func (p *membersPage) focus(kind string, id int) {
	if kind == "member" {
		p.selected = id
	}
}

func (p *membersPage) build(c *widget.Context) widget.Component {
	p.title = widget.PageTitle(p.label(c))
	p.stale = true
	return p
}

func (p *membersPage) head(c *widget.Context, width float32) float32 {
	return p.title.Measure(c, width).H + p.filter.Measure(c, width).H + membersFilterGap
}

// fill is the height the list and the editor share: what the page has, less what is over them.
func (p *membersPage) fill(c *widget.Context) float32 {
	return max(p.d.win.PageHeight(c), membersMinHeight) - p.head(c, c.Viewport.W)
}

func (p *membersPage) Measure(c *widget.Context, maxWidth float32) geom.Size {
	p.sync(c)
	return geom.Size{W: maxWidth, H: p.head(c, maxWidth) + p.split.Measure(c, maxWidth).H}
}

func (p *membersPage) Draw(c *widget.Context, r geom.Rect) {
	p.sync(c)
	y := r.Y
	h := p.title.Measure(c, r.W).H
	p.title.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
	y += h
	p.filter.Placeholder = c.T("server_admin.find_someone")
	h = p.filter.Measure(c, r.W).H
	p.filter.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: h})
	y += h + membersFilterGap
	p.split.Draw(c, geom.Rect{X: r.X, Y: y, W: r.W, H: r.Bottom() - y})
}

// sync makes the list and the editor again when what they are made from changed.
func (p *membersPage) sync(c *widget.Context) {
	st := p.d.state
	query := strings.TrimSpace(p.filter.Value)
	if !p.stale && st == p.seen && query == p.seenFilter && p.selected == p.seenSelect && c.Strings == p.seenStrs {
		return
	}
	p.seen, p.seenFilter, p.seenSelect, p.seenStrs, p.stale = st, query, p.selected, c.Strings, false
	people := p.rows(c, st, query)
	p.list.Rows = people
	p.editor(c, st)
}

func (p *membersPage) selectMember(id int) {
	p.selected, p.problem = id, ""
}

// failed shows what went wrong, and has the page made again so that a switch that was turned goes back to what the server holds.
func (p *membersPage) failed(err error) {
	p.stale = true
	if err != nil {
		p.problem = err.Error()
	}
	redraw.Request()
}

var nameFace = paint.TextStyle{Size: 14, Weight: paint.Regular}

func (p *membersPage) rank(st *app.State, a hclient.Account) int {
	return hclient.ActorOf(userOf(a), st.Roles).Rank
}

func userOf(a hclient.Account) hclient.User {
	return hclient.User{ID: a.ID, Nickname: a.Nickname, DisplayName: a.DisplayName, Role: a.Role, Roles: a.Roles}
}

type ranked struct {
	account hclient.Account
	rank    int
}

// rows is the people who match the search, the hierarchy first, then by name.
func (p *membersPage) rows(c *widget.Context, st *app.State, query string) []widget.AdminRow {
	needle := strings.ToLower(query)
	var found []ranked
	for _, a := range st.Members {
		if needle == "" || strings.Contains(strings.ToLower(a.Name()), needle) || strings.Contains(strings.ToLower(a.Nickname), needle) {
			found = append(found, ranked{a, p.rank(st, a)})
		}
	}
	slices.SortFunc(found, func(a, b ranked) int {
		if a.rank != b.rank {
			return b.rank - a.rank
		}
		return strings.Compare(strings.ToLower(a.account.Name()), strings.ToLower(b.account.Name()))
	})
	rows := make([]widget.AdminRow, 0, len(found))
	for _, f := range found {
		rows = append(rows, p.row(c, st, f.account))
	}
	return rows
}

func (p *membersPage) row(c *widget.Context, st *app.State, a hclient.Account) widget.AdminRow {
	id := a.ID
	row := widget.AdminRow{
		Lead:     widget.Padded{Right: rowAvatarGap, Child: widget.Avatar{ID: id, Name: a.Name(), Size: 12.6, Font: 8.4}},
		Name:     p.nameOf(c, a, nameFace, a.Banned),
		Selected: id == p.selected,
		OnClick:  func() { p.selectMember(id) },
	}
	if a.Role == "owner" || a.Role == "admin" {
		row.Trail = append(row.Trail, widget.RoleIcon{Owner: a.Role == "owner"})
	}
	if chips := chipsOf(c, st, a); len(chips) > 0 {
		row.Trail = append(row.Trail, widget.RoleChips{Chips: chips, Share: 0.5})
	}
	return row
}

func (p *membersPage) nameOf(c *widget.Context, a hclient.Account, face paint.TextStyle, banned bool) *widget.NameLabel {
	label := &widget.NameLabel{Text: a.Name(), Face: face, Ink: c.Theme.Text}
	if entry := p.d.Session.People().ByID(a.ID); entry != nil {
		label.Look = &entry.Style
	}
	if banned {
		label.Opacity, label.Strike = 0.6, true
	}
	return label
}
