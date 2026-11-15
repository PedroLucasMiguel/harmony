package channels

import (
	"image/color"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/theme"
	"harmony/v2/internal/ui/widget"
)

const (
	mentionWidth     = 320
	mentionMaxHeight = 224
	mentionPad       = 4.8
	mentionRadius    = 10
	mentionRowPadY   = 5.6
	mentionRowPadX   = 6.4
	mentionRowGap    = 8
	mentionRowRadius = 6
	mentionRowLine   = 21
	mentionEdge      = 8
	mentionAbove     = 6
	mentionFace      = 12.6
	mentionFaceGap   = 2.94
	mentionDot       = 9.8
	mentionNoteSize  = 12.48
	mentionActive    = 0.22
	mentionShadowY   = 12
	mentionShadowBlr = 32
	mentionShadowA   = 140
	mentionMaxPeople = 8
	mentionMaxRoles  = 5
	mentionMaxPlaces = 8
	everyoneHandle   = "everyone"
	channelEnd       = " \t\r\n#@:.,;!?()[]{}<>\"'`*~|\\/"
)

var (
	mentionNote = paint.TextStyle{Size: mentionNoteSize, Weight: paint.Regular}
	mentionBody = paint.TextStyle{Size: 14, Weight: paint.Regular}
	mentionBold = paint.TextStyle{Size: 14, Weight: paint.Semibold}
)

type mentionKind uint8

const (
	mentionPerson mentionKind = iota
	mentionRole
	mentionEveryone
	mentionPlace
)

type mentionMatch struct {
	kind   mentionKind
	insert string
	label  string
	note   string
	id     int
	colour color.RGBA
	forum  bool
}

// mentionList is the pop-up that completes an @name or #channel being typed.
type mentionList struct {
	open    bool
	matches []mentionMatch
	active  int
	scroll  float32
	at      int
	caret   int
	value   string
	known   bool
	reveal  bool
}

func isWordRune(r rune) bool {
	return r == '_' || r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r))
}

func nicknameRune(r rune) bool {
	return r == '_' || r == '-' || r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r))
}

// mentionToken finds the @ or # being typed at the caret: where it starts and which it is, or -1.
func mentionToken(text []rune, caret int) (at int, kind rune) {
	mention, place := -1, -1
	if i := lastIndex(text[:caret], '@'); i >= 0 && (i == 0 || !isWordRune(text[i-1]) && text[i-1] != '@') && !slices.ContainsFunc(text[i+1:caret], func(r rune) bool { return !nicknameRune(r) }) {
		mention = i
	}
	if i := lastIndex(text[:caret], '#'); i >= 0 && (i == 0 || !isWordRune(text[i-1]) && text[i-1] != '#' && text[i-1] != '&') && !slices.ContainsFunc(text[i+1:caret], func(r rune) bool { return strings.ContainsRune(channelEnd, r) }) {
		place = i
	}
	switch {
	case mention < 0 && place < 0:
		return -1, 0
	case mention > place:
		return mention, '@'
	}
	return place, '#'
}

func lastIndex(text []rune, r rune) int {
	for i := len(text) - 1; i >= 0; i-- {
		if text[i] == r {
			return i
		}
	}
	return -1
}

// roleHandle is what a role is called in a message, as the server folds it: ASCII letters, digits, dash and underscore.
func roleHandle(name string) string {
	var out []rune
	dash := false
	for _, r := range strings.ToLower(foldAccents(name)) {
		if r < 128 && (unicode.IsLower(r) || unicode.IsDigit(r) || r == '_' || r == '-') {
			out = append(out, r)
			dash = false
		} else if !dash {
			out = append(out, '-')
			dash = true
		}
	}
	handle := strings.TrimLeft(string(out), "-_")
	handle = strings.TrimRight(handle, "-")
	if len(handle) > 24 {
		handle = strings.TrimRight(handle[:24], "-")
	}
	return handle
}

func foldAccents(s string) string {
	var out strings.Builder
	for _, r := range norm.NFD.String(s) {
		if !unicode.Is(unicode.Mn, r) {
			out.WriteRune(r)
		}
	}
	return out.String()
}

// channelHandle is what a channel is called in a message: lower case, spaces as dashes, without what ends a word.
func channelHandle(name string) string {
	var out strings.Builder
	space := false
	for _, r := range strings.ToLower(name) {
		switch {
		case unicode.IsSpace(r):
			if !space {
				out.WriteByte('-')
			}
			space = true
			continue
		case strings.ContainsRune(channelEnd, r):
		default:
			out.WriteRune(r)
		}
		space = false
	}
	return out.String()
}

func (s *Screen) mentionMatches(c *widget.Context, m model, kind rune, query string) []mentionMatch {
	q := strings.ToLower(query)
	if kind == '#' {
		return s.placeMatches(m, q)
	}
	type person struct {
		acc  hclient.Account
		rank int
	}
	var people []person
	for _, a := range m.state.Members {
		nick := strings.ToLower(a.Nickname)
		if strings.Contains(nick, q) || strings.Contains(strings.ToLower(a.Name()), q) {
			rank := 1
			if strings.HasPrefix(nick, q) {
				rank = 0
			}
			people = append(people, person{a, rank})
		}
	}
	slices.SortStableFunc(people, func(a, b person) int {
		if a.rank != b.rank {
			return a.rank - b.rank
		}
		return strings.Compare(strings.ToLower(a.acc.Name()), strings.ToLower(b.acc.Name()))
	})
	if len(people) > mentionMaxPeople {
		people = people[:mentionMaxPeople]
	}
	out := make([]mentionMatch, 0, len(people)+mentionMaxRoles+1)
	named := map[string]bool{}
	for _, p := range people {
		named[strings.ToLower(p.acc.Nickname)] = true
		out = append(out, mentionMatch{kind: mentionPerson, insert: "@" + p.acc.Nickname, label: p.acc.Name(), note: "@" + p.acc.Nickname, id: p.acc.ID})
	}
	roles := slices.Clone(m.state.Roles)
	slices.SortStableFunc(roles, func(a, b hclient.Role) int { return a.Position - b.Position })
	taken := 0
	for _, role := range roles {
		handle := roleHandle(role.Name)
		if handle == "" || taken == mentionMaxRoles || named[handle] || accountNamed(m.state.Members, handle) || firstRoleWith(roles, handle) != role.ID {
			continue
		}
		if !strings.Contains(handle, q) && !strings.Contains(strings.ToLower(role.Name), q) {
			continue
		}
		count := 0
		for _, a := range m.state.Members {
			if slices.Contains(a.Roles, role.ID) {
				count++
			}
		}
		colour, _ := parseHex(role.Color)
		out = append(out, mentionMatch{kind: mentionRole, insert: "@" + handle, label: role.Name, note: c.Strings.Plural("app.notifies_role_members", count, "count", strconv.Itoa(count)), colour: colour, id: role.ID})
		taken++
	}
	if strings.HasPrefix(everyoneHandle, q) {
		out = append(out, mentionMatch{kind: mentionEveryone, insert: "@" + everyoneHandle, label: "@everyone", note: c.T("app.notifies_the_whole_server")})
	}
	return out
}

func accountNamed(members []hclient.Account, handle string) bool {
	return slices.ContainsFunc(members, func(a hclient.Account) bool { return strings.ToLower(a.Nickname) == handle })
}

func firstRoleWith(roles []hclient.Role, handle string) int {
	for _, r := range roles {
		if roleHandle(r.Name) == handle {
			return r.ID
		}
	}
	return 0
}

func (s *Screen) placeMatches(m model, q string) []mentionMatch {
	seen := map[string]bool{}
	var out []mentionMatch
	for _, ch := range m.channels {
		if ch.Kind != "text" && ch.Kind != "forum" {
			continue
		}
		handle := channelHandle(ch.Name)
		if handle == "" || seen[handle] {
			continue
		}
		seen[handle] = true
		if !strings.Contains(handle, q) && !strings.Contains(strings.ToLower(ch.Name), q) {
			continue
		}
		note := ""
		if handle != strings.ToLower(ch.Name) {
			note = "#" + handle
		}
		out = append(out, mentionMatch{kind: mentionPlace, insert: "#" + handle, label: ch.Name, note: note, id: ch.ID, forum: ch.Kind == "forum"})
	}
	slices.SortStableFunc(out, func(a, b mentionMatch) int {
		pa, pb := strings.HasPrefix(a.insert[1:], q), strings.HasPrefix(b.insert[1:], q)
		switch {
		case pa && !pb:
			return -1
		case pb && !pa:
			return 1
		}
		return 0
	})
	if len(out) > mentionMaxPlaces {
		out = out[:mentionMaxPlaces]
	}
	return out
}

// mentionKeys takes the keys the list is driven with before the box sees them.
func (s *Screen) mentionKeys(c *widget.Context) {
	list := &s.chat.mention
	if !list.open || len(list.matches) == 0 || !s.chat.input.Focused(c) {
		return
	}
	in := &c.In
	switch {
	case in.KeyDown || in.KeyUp:
		step := 1
		if in.KeyUp {
			step = -1
		}
		list.active = (list.active + step + len(list.matches)) % len(list.matches)
		list.reveal = true
		in.KeyDown, in.KeyUp = false, false
	case in.Enter && !in.Shift || in.Tab:
		s.acceptMention(list.active)
		in.Enter, in.Tab = false, false
	case in.Escape:
		list.open = false
		in.Escape = false
	}
}

func (s *Screen) acceptMention(index int) {
	list := &s.chat.mention
	if index >= len(list.matches) {
		return
	}
	list.open = false
	s.chat.input.Replace(list.at, s.chat.input.Caret(), list.matches[index].insert+" ")
}

// showMentions keeps the list in step with the box and draws it above it.
func (s *Screen) showMentions(c *widget.Context, m model, box geom.Rect) {
	list := &s.chat.mention
	st := &s.chat
	if !st.input.Focused(c) {
		list.open, list.known = false, false
		return
	}
	text, caret := st.input.Runes(), st.input.Caret()
	if st.input.SelectedLength() > 0 {
		list.open = false
		return
	}
	if value := st.input.Value(); !list.known || list.value != value || list.caret != caret {
		list.known, list.value, list.caret = true, value, caret
		at, kind := mentionToken(text, min(caret, len(text)))
		list.open = false
		if at >= 0 {
			typed := string(text[at+1 : caret])
			list.matches = s.mentionMatches(c, m, kind, typed)
			list.at, list.open = at, len(list.matches) > 0
			list.active = min(list.active, max(len(list.matches)-1, 0))
			list.reveal = true
		}
	}
	if !list.open {
		return
	}
	c.Overlay(func() { s.drawMentions(c, box) })
}

func (s *Screen) drawMentions(c *widget.Context, box geom.Rect) {
	list := &s.chat.mention
	edge := c.Hairline()
	rowH := float32(2*mentionRowPadY + mentionRowLine)
	content := float32(len(list.matches))*rowH + 2*mentionPad
	h := min(content+2*edge, mentionMaxHeight)
	w := min(mentionWidth, c.Viewport.W-32)
	x := max(mentionEdge, min(box.X, c.Viewport.W-w-mentionEdge))
	y := box.Y - h - mentionAbove
	if y < mentionEdge {
		y = min(box.Bottom()+mentionAbove, c.Viewport.H-h-mentionEdge)
	}
	pop := geom.Rect{X: x, Y: y, W: w, H: h}
	c.Popup(pop)
	c.Paint.Shadow(pop, mentionRadius, mentionShadowY, mentionShadowBlr, color.RGBA{A: mentionShadowA})
	c.Paint.Fill(pop, mentionRadius, c.Theme.Surface)
	c.Paint.Stroke(pop, mentionRadius, edge, c.Theme.Border)

	view := geom.Rect{X: pop.X + edge, Y: pop.Y + edge, W: pop.W - 2*edge, H: pop.H - 2*edge}
	maxScroll := max(0, content-view.H)
	if c.Hovered(pop) {
		list.scroll -= c.In.Wheel * rowH
	}
	if list.reveal {
		list.reveal = false
		top := mentionPad + float32(list.active)*rowH
		list.scroll = min(max(list.scroll, top+rowH+mentionPad-view.H), top-mentionPad)
	}
	list.scroll = min(max(list.scroll, 0), maxScroll)
	c.Paint.PushClip(view)
	for i := range list.matches {
		row := geom.Rect{X: view.X + mentionPad, Y: view.Y + mentionPad + float32(i)*rowH - list.scroll, W: view.W - 2*mentionPad, H: rowH}
		if row.Bottom() < view.Y || row.Y > view.Bottom() {
			continue
		}
		if c.Hovered(row) && c.In.Moved && list.active != i {
			list.active = i
		}
		if c.Hovered(row) && c.Clicked(row) {
			c.Claim()
			s.acceptMention(i)
			c.Paint.PopClip()
			return
		}
		if i == list.active {
			c.Paint.Fill(row, mentionRowRadius, theme.WithAlpha(c.Theme.Accent, mentionActive))
		}
		s.drawMention(c, row, &list.matches[i])
	}
	c.Paint.PopClip()
	if c.Hovered(pop) {
		c.SetCursor(rl.MouseCursorPointingHand)
	}
}

func (s *Screen) drawMention(c *widget.Context, row geom.Rect, match *mentionMatch) {
	x := row.X + mentionRowPadX
	right := row.Right() - mentionRowPadX
	top := row.Y + mentionRowPadY
	if match.note != "" {
		nw := c.Paint.TextWidth(match.note, mentionNote)
		c.Paint.Text(match.note, right-nw, top+(mentionRowLine-mentionNoteSize*1.5)/2, mentionNoteSize*1.5, mentionNote, c.Theme.Muted)
		right -= nw + mentionRowGap
	}
	switch match.kind {
	case mentionPerson:
		widget.Avatar{Name: match.label, ID: match.id, Size: mentionFace, Font: 6}.Draw(c, geom.Rect{X: x, Y: row.Y + (row.H-mentionFace)/2, W: mentionFace, H: mentionFace})
		x += mentionFace + mentionFaceGap + mentionRowGap
	case mentionRole:
		dot := match.colour
		if dot.A == 0 {
			dot = c.Theme.Muted
		}
		c.Paint.Circle(x+mentionDot/2, row.Y+row.H/2, mentionDot/2, dot)
		x += mentionDot + mentionRowGap
	case mentionPlace:
		icon := "hash"
		if match.forum {
			icon = "chats-teardrop"
		}
		c.Paint.Icon(icon, geom.Rect{X: x, Y: row.Y + (row.H-mentionRowLine)/2 + 2.5, W: 16, H: 16}, c.Theme.Muted)
		x += 16 + mentionRowGap
	}
	style, ink := mentionBody, c.Theme.Text
	if match.kind == mentionEveryone {
		style = mentionBold
	}
	if match.kind == mentionRole && match.colour.A != 0 {
		ink = match.colour
	}
	c.Paint.TextIn(geom.Rect{X: x, Y: row.Y, W: max(0, right-x), H: row.H}, match.label, x, top, mentionRowLine, style, ink)
}
