package channels

import (
	"slices"
	"strings"

	"harmony/v2/internal/hclient"
)

const popValues = 8

func contains(candidate, partial string) bool {
	return partial == "" || strings.Contains(strings.ToLower(candidate), strings.ToLower(partial))
}

// byStart puts what begins with the typed letters before what only holds them.
func byStart(partial string, label func(int) string) func(a, b int) int {
	return func(a, b int) int {
		starts := func(i int) int {
			if strings.HasPrefix(strings.ToLower(label(i)), strings.ToLower(partial)) {
				return 0
			}
			return 1
		}
		if d := starts(a) - starts(b); d != 0 {
			return d
		}
		return strings.Compare(strings.ToLower(label(a)), strings.ToLower(label(b)))
	}
}

// valueItems lists what the filter being typed can be, narrowed by what was typed of it.
func (s *Screen) valueItems(m model, key, partial string) {
	c := s.chat.find.c
	q := &s.chat.find.search
	p := &q.pop
	word := strings.Trim(partial, `"`)
	pick := func(chip filter) func() {
		return func() {
			q.field.SetValue(strings.TrimRight(trailingToken.ReplaceAllString(q.field.Value, ""), " "))
			q.addChip(chip)
			q.field.RequestFocus()
			p.dirty = true
			s.searchNow()
		}
	}
	add := func(heading string, rows []popRow) {
		if len(rows) == 0 {
			return
		}
		p.items = append(p.items, popItem{heading: heading})
		for _, r := range rows {
			p.items = append(p.items, popItem{row: r})
		}
	}
	var rows []popRow
	switch key {
	case "from", "mentions":
		name := strings.TrimPrefix(word, "@")
		var found []hclient.Account
		for _, a := range m.state.Members {
			if contains(a.Nickname, name) || contains(a.Name(), name) {
				found = append(found, a)
			}
		}
		order := make([]int, len(found))
		for i := range order {
			order[i] = i
		}
		slices.SortFunc(order, byStart(name, func(i int) string { return found[i].Name() }))
		for _, i := range order[:min(len(order), popValues)] {
			a := found[i]
			row := popRow{face: a.Name(), title: a.Name(), pre: true, choose: pick(filter{key: key, id: a.ID, label: a.Name()})}
			if !strings.EqualFold(a.Name(), a.Nickname) {
				row.hint = a.Nickname
			}
			rows = append(rows, row)
		}
		add(c.T("search.people"), rows)
	case "in":
		name := strings.TrimPrefix(word, "#")
		var found []hclient.Channel
		for _, ch := range searchable(m) {
			if contains(ch.Name, name) {
				found = append(found, ch)
			}
		}
		order := make([]int, len(found))
		for i := range order {
			order[i] = i
		}
		slices.SortFunc(order, byStart(name, func(i int) string { return found[i].Name }))
		for _, i := range order[:min(len(order), popValues)] {
			ch := found[i]
			rows = append(rows, popRow{icon: "hash", title: ch.Name, pre: true, choose: pick(filter{key: key, id: ch.ID, label: ch.Name})})
		}
		add(c.T("search.channels"), rows)
	case "has":
		for _, kind := range hasKinds {
			if !contains(kind, word) {
				continue
			}
			icon := "paperclip"
			if kind == "link" || kind == "embed" {
				icon = "link"
			}
			rows = append(rows, popRow{icon: icon, title: c.T("search.has_" + kind), hint: kind, pre: true, choose: pick(filter{key: key, word: kind, label: kind})})
		}
		add(c.T("search.kinds"), rows)
	case "pinned":
		for _, flag := range []string{"true", "false"} {
			if contains(flag, word) {
				rows = append(rows, popRow{icon: "push-pin", title: c.T("search." + flag), pre: true, choose: pick(filter{key: key, word: flag, label: flag})})
			}
		}
		add(c.T("search.pinned"), rows)
	default:
		var wanted []string
		if iso, ok := parseDate(word); ok {
			wanted = append(wanted, iso)
		}
		for _, easy := range []string{"today", "yesterday"} {
			iso, _ := parseDate(easy)
			if strings.HasPrefix(easy, strings.ToLower(word)) && !slices.Contains(wanted, iso) {
				wanted = append(wanted, iso)
			}
		}
		for _, iso := range wanted {
			rows = append(rows, popRow{icon: "clock-counter-clockwise", title: iso, pre: true, choose: pick(filter{key: key, word: iso, label: iso})})
		}
		add(c.T("search.date_hint"), rows)
	}
}
