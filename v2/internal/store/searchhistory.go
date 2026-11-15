package store

import "slices"

const maxSearchHistory = 10

// SearchChip is a filter that was chosen in a search; Value is an id, a kind, a date or a flag, as the Electron client keeps it.
type SearchChip struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
	Label string `json:"label"`
}

// SearchEntry is one search that was made: the words and the filters.
type SearchEntry struct {
	Text  string       `json:"text"`
	Chips []SearchChip `json:"chips"`
}

func (e SearchEntry) same(o SearchEntry) bool {
	return e.Text == o.Text && slices.EqualFunc(e.Chips, o.Chips, func(a, b SearchChip) bool {
		return a.Key == b.Key && a.Value == b.Value && a.Label == b.Label
	})
}

// RememberSearch puts a search first among those kept for a server. It does not save the settings.
func (s *Settings) RememberSearch(server string, entry SearchEntry) {
	if s.SearchHistory == nil {
		s.SearchHistory = map[string][]SearchEntry{}
	}
	list := slices.DeleteFunc(slices.Clone(s.SearchHistory[server]), entry.same)
	s.SearchHistory[server] = slices.Insert(list, 0, entry)[:min(len(list)+1, maxSearchHistory)]
}

// ForgetSearches empties a server's history. It does not save the settings.
func (s *Settings) ForgetSearches(server string) { delete(s.SearchHistory, server) }
