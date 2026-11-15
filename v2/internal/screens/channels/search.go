package channels

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"time"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/widget"
)

const (
	searchPage = 25
	dayMillis  = 24 * 60 * 60 * 1000
	dayLayout  = "2006-01-02"
)

var (
	filterKeys    = []string{"from", "in", "has", "mentions", "before", "during", "after", "pinned"}
	hasKinds      = []string{"link", "embed", "file", "image", "video", "sound"}
	trailingToken = regexp.MustCompile(`(?i)(?:^|\s)(from|in|has|mentions|before|during|after|pinned):(\S*)$`)
	tokenWord     = regexp.MustCompile(`(?i)^(from|in|has|mentions|before|during|after|pinned):(\S+)$`)
)

// filter is a condition chosen for a search: who wrote it, where, what it has, when, whether it is pinned.
type filter struct {
	key   string
	id    int
	word  string
	label string
}

func (f filter) single() bool {
	return f.key == "before" || f.key == "after" || f.key == "during" || f.key == "pinned"
}

func (f filter) value() any {
	if f.id != 0 {
		return f.id
	}
	if f.key == "pinned" {
		return f.word == "true"
	}
	return f.word
}

// searchState is the search box with what is chosen in it, and the answers to the last search made.
type searchState struct {
	field  widget.TextField
	chips  []filter
	oldest bool
	typed  string
	had    bool
	model  model
	wired  bool

	hint      string
	hintTitle string
	hintFor   *i18n.Bundle

	pop   searchPop
	panel resultsPanel

	open    bool
	text    string
	page    int
	total   int
	capped  bool
	loading bool
	failure string
	results []hclient.ChatMessage
	ticket  int
	version int
}

func dayStart(iso string) (int64, bool) {
	t, err := time.ParseInLocation(dayLayout, iso, time.Local)
	if err != nil || t.Format(dayLayout) != iso {
		return 0, false
	}
	return t.UnixMilli(), true
}

// parseDate reads 2026-10-30, today or yesterday as a date.
func parseDate(raw string) (string, bool) {
	word := strings.ToLower(strings.TrimSpace(raw))
	switch word {
	case "today":
		return time.Now().Format(dayLayout), true
	case "yesterday":
		return time.Now().AddDate(0, 0, -1).Format(dayLayout), true
	}
	_, ok := dayStart(word)
	return word, ok
}

func (q *searchState) addChip(chip filter) {
	q.chips = slices.DeleteFunc(q.chips, func(c filter) bool {
		return c.key == chip.key && (chip.single() || (c.id == chip.id && c.word == chip.word))
	})
	q.chips = append(q.chips, chip)
}

func (q *searchState) removeChip(at int) { q.chips = slices.Delete(q.chips, at, at+1) }

// resolve reads what was typed after a filter's name as a chip, when it names somebody or something.
func resolve(m model, key, raw string) (filter, bool) {
	word := strings.Trim(raw, `"`)
	switch key {
	case "from", "mentions":
		name := strings.ToLower(strings.TrimPrefix(word, "@"))
		for _, a := range m.state.Members {
			if strings.ToLower(a.Nickname) == name || strings.ToLower(a.Name()) == name {
				return filter{key: key, id: a.ID, label: a.Name()}, true
			}
		}
	case "in":
		name := strings.ToLower(strings.TrimPrefix(word, "#"))
		for _, ch := range searchable(m) {
			if strings.ToLower(ch.Name) == name {
				return filter{key: key, id: ch.ID, label: ch.Name}, true
			}
		}
	case "has":
		kind := strings.ToLower(word)
		if slices.Contains(hasKinds, kind) {
			return filter{key: key, word: kind, label: kind}, true
		}
	case "pinned":
		flag := strings.ToLower(word)
		if flag == "true" || flag == "false" {
			return filter{key: key, word: flag, label: flag}, true
		}
	default:
		if iso, ok := parseDate(word); ok {
			return filter{key: key, word: iso, label: iso}, true
		}
	}
	return filter{}, false
}

// searchable is the channels a search can be limited to.
func searchable(m model) []hclient.Channel {
	var list []hclient.Channel
	for _, ch := range m.channels {
		if ch.Kind == "text" {
			list = append(list, ch)
		}
	}
	return list
}

// absorbTokens turns each complete filter typed in the box (from:ana followed by a space) into a chip; words that name nobody stay words.
func (q *searchState) absorbTokens(m model) (changed bool) {
	value := q.field.Value
	var rest []string
	for _, word := range strings.Fields(value) {
		if found := tokenWord.FindStringSubmatch(word); found != nil {
			if chip, ok := resolve(m, strings.ToLower(found[1]), found[2]); ok {
				q.addChip(chip)
				changed = true
				continue
			}
		}
		rest = append(rest, word)
	}
	if !changed {
		return false
	}
	text := strings.Join(rest, " ")
	if text != "" && strings.HasSuffix(value, " ") {
		text += " "
	}
	q.field.SetValue(text)
	return true
}

// query is the request for what is typed and chosen, for one page of the answers.
func (q *searchState) query(text string, page int) hclient.SearchQuery {
	req := hclient.SearchQuery{Text: text, Oldest: q.oldest, Offset: page * searchPage, Limit: searchPage}
	var after, before int64
	for _, c := range q.chips {
		switch c.key {
		case "from":
			req.From = append(req.From, c.id)
		case "in":
			req.In = append(req.In, c.id)
		case "mentions":
			req.Mentions = append(req.Mentions, c.id)
		case "has":
			kind := c.word
			if kind == "sound" {
				kind = "audio"
			}
			req.Has = append(req.Has, kind)
		case "pinned":
			req.Pinned = -1
			if c.word == "true" {
				req.Pinned = 1
			}
		case "after", "before", "during":
			start, ok := dayStart(c.word)
			if !ok {
				continue
			}
			lift := func(v int64) { after = max(after, v) }
			lower := func(v int64) {
				if before == 0 || v < before {
					before = v
				}
			}
			switch c.key {
			case "after":
				lift(start + dayMillis - 1)
			case "before":
				lower(start)
			default:
				lift(start - 1)
				lower(start + dayMillis)
			}
		}
	}
	req.After, req.Before = after, before
	return req
}

// run asks the server for a page of the answers; one that arrives after a newer search was made is dropped.
func (s *Screen) runSearch(text string, page int, save bool) {
	q := &s.chat.find.search
	c := s.chat.find.c
	if text == "" && len(q.chips) == 0 {
		return
	}
	q.ticket++
	mine := q.ticket
	q.open, q.loading, q.text, q.page, q.failure = true, true, text, page, ""
	if save {
		s.rememberSearch(text, q.chips)
	}
	req := q.query(text, page)
	if s.chat.channel < 0 {
		req.Thread = -s.chat.channel
	}
	client := s.Session.Client()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		res, err := client.Search(ctx, req)
		c.Post(func() {
			if mine != q.ticket {
				return
			}
			q.loading = false
			q.version++
			if err != nil {
				q.total, q.capped, q.results, q.failure = 0, false, nil, err.Error()
				return
			}
			q.total, q.capped, q.results = res.Total, res.Capped, res.Results
		})
	}()
}

func (s *Screen) rememberSearch(text string, chips []filter) {
	entry := store.SearchEntry{Text: text}
	for _, c := range chips {
		entry.Chips = append(entry.Chips, store.SearchChip{Key: c.key, Value: c.value(), Label: c.label})
	}
	s.Settings.RememberSearch(store.ServerKey(s.Server.URL), entry)
	s.Settings.Save()
}

// searchNow searches again after a filter changed, with nothing to wait for; with nothing left to look for the answers go.
func (s *Screen) searchNow() {
	q := &s.chat.find.search
	text := strings.TrimSpace(q.field.Value)
	if text == "" && len(q.chips) == 0 {
		q.closeResults()
		return
	}
	s.runSearch(text, 0, false)
}

// submit is Enter in the box: the words and filters are searched, and remembered.
func (s *Screen) submitSearch() {
	q := &s.chat.find.search
	q.absorbTokens(q.model)
	q.pop.close()
	s.runSearch(strings.TrimSpace(q.field.Value), 0, true)
}

func (q *searchState) closeResults() {
	q.ticket++
	q.open, q.loading = false, false
	q.panel.sortOpen = false
}

func (q *searchState) clearAll() {
	q.chips = q.chips[:0]
	q.field.SetValue("")
	q.pop.close()
	q.closeResults()
}

func (q *searchState) pageCount() int { return (q.total + searchPage - 1) / searchPage }
